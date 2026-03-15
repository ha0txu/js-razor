import type { ReviewConfig, Finding, AgentResult, FileDiff, ToolCall } from "../types/index.js";
import type { LLMClient, LLMMessage, LLMContent } from "../providers/types.js";
import { createClient } from "../providers/index.js";
import { AgentToolkit } from "../tools/agent-tools.js";
import { VERIFICATION_AGENT_PROMPT } from "../prompts/system-prompts.js";

/**
 * Verification Agent: Cross-verifies findings from all specialized agents.
 *
 * Provider-agnostic: works with both Claude and Gemini models.
 *
 * This is the KEY differentiator in the architecture.
 * It re-reads the actual code for each finding and attempts to DISPROVE it.
 * Findings that can't be disproven pass through; false positives are filtered.
 */
export class VerificationAgent {
  private client: LLMClient;
  private config: ReviewConfig;
  private toolkit: AgentToolkit;
  private model: string;

  constructor(config: ReviewConfig) {
    this.config = config;
    this.model = config.model_verification;
    this.client = createClient(config, this.model);
    this.toolkit = new AgentToolkit(config);
  }

  /**
   * Verify a set of findings from multiple agents.
   * Returns only confirmed or modified findings.
   */
  async verify(
    findings: Finding[],
    files: FileDiff[],
    headRef: string,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    if (findings.length === 0) {
      return {
        agent_name: "verification",
        findings: [],
        tokens_used: 0,
        duration_ms: 0,
      };
    }

    try {
      this.toolkit.setPRContext(files, headRef);

      // Build the verification prompt with all findings
      const findingsText = findings
        .map((f, i) => {
          return [
            `--- Finding ${i} ---`,
            `Agent: ${f.category}`,
            `File: ${f.file}:${f.line_start}-${f.line_end}`,
            `Severity: ${f.severity} | Confidence: ${f.confidence}`,
            `Title: ${f.title}`,
            `Description: ${f.description}`,
            `Code: ${f.code_snippet}`,
            f.suggestion ? `Suggestion: ${f.suggestion}` : "",
            f.similar_pr_reference ? `Past PR: ${f.similar_pr_reference}` : "",
          ].filter(Boolean).join("\n");
        })
        .join("\n\n");

      const prompt = [
        `You have ${findings.length} findings to verify.`,
        `For each finding, use the read_file tool to check the actual code.`,
        "",
        findingsText,
      ].join("\n");

      // Run the agentic loop (provider-agnostic)
      const messages: LLMMessage[] = [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ];

      let verdicts: Array<{
        original_finding_index: number;
        verdict: "confirmed" | "rejected" | "modified";
        reason: string;
        modified_finding?: Finding;
      }> = [];

      let iterations = 0;
      const maxIterations = Math.min(findings.length + 3, 12);

      while (iterations < maxIterations) {
        iterations++;

        const response = await this.client.chat({
          model: this.model,
          max_tokens: 4096,
          system: VERIFICATION_AGENT_PROMPT,
          messages,
          tools: this.toolkit.getToolDefinitions(),
        });

        totalTokens += response.usage.input_tokens + response.usage.output_tokens;

        if (response.tool_calls.length === 0 || response.stop_reason === "end_turn") {
          verdicts = this.parseVerdicts(response.text_content);
          break;
        }

        // Build assistant message
        const assistantContent: LLMContent[] = [];
        if (response.text_content) {
          assistantContent.push({ type: "text", text: response.text_content });
        }
        for (const tc of response.tool_calls) {
          assistantContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
            ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
          });
        }
        messages.push({ role: "assistant", content: assistantContent });

        // Execute tool calls
        const toolResultContent: LLMContent[] = [];
        for (const tc of response.tool_calls) {
          const call: ToolCall = { id: tc.id, name: tc.name, input: tc.input };
          const result = await this.toolkit.executeTool(call);
          toolResultContent.push({
            type: "tool_result",
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
          });
        }
        messages.push({ role: "user", content: toolResultContent });
      }

      // Apply verdicts to findings
      const verifiedFindings: Finding[] = [];
      for (const verdict of verdicts) {
        const idx = verdict.original_finding_index;
        if (idx < 0 || idx >= findings.length) continue;

        if (verdict.verdict === "confirmed") {
          verifiedFindings.push(findings[idx]);
        } else if (verdict.verdict === "modified" && verdict.modified_finding) {
          verifiedFindings.push({
            ...findings[idx],
            ...verdict.modified_finding,
          });
        }
      }

      // Findings not covered by any verdict are kept (conservative approach)
      const coveredIndices = new Set(verdicts.map((v) => v.original_finding_index));
      for (let i = 0; i < findings.length; i++) {
        if (!coveredIndices.has(i)) {
          verifiedFindings.push({
            ...findings[i],
            confidence: Math.min(findings[i].confidence, 0.6),
          });
        }
      }

      const rejectedCount = verdicts.filter((v) => v.verdict === "rejected").length;
      console.log(
        `  [verification] ${verifiedFindings.length} confirmed, ${rejectedCount} rejected, ` +
        `${findings.length - coveredIndices.size} unverified (kept at lower confidence)`,
      );

      return {
        agent_name: "verification",
        findings: verifiedFindings,
        tokens_used: totalTokens,
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      console.error(`  [verification] Error: ${(error as Error).message}`);
      return {
        agent_name: "verification",
        findings: findings.map((f) => ({
          ...f,
          confidence: Math.min(f.confidence, 0.5),
        })),
        tokens_used: totalTokens,
        duration_ms: Date.now() - startTime,
        error: `Verification failed: ${(error as Error).message}`,
      };
    }
  }

  private parseVerdicts(text: string): Array<{
    original_finding_index: number;
    verdict: "confirmed" | "rejected" | "modified";
    reason: string;
    modified_finding?: Finding;
  }> {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      return JSON.parse(jsonMatch[0]);
    } catch {
      console.warn("  [verification] Failed to parse verdicts");
      return [];
    }
  }
}
