import Anthropic from "@anthropic-ai/sdk";
import type { ReviewConfig, Finding, AgentResult, FileDiff, ToolCall } from "../types/index.js";
import { AgentToolkit } from "../tools/agent-tools.js";
import { VERIFICATION_AGENT_PROMPT } from "../prompts/system-prompts.js";

/**
 * Verification Agent: Cross-verifies findings from all specialized agents.
 *
 * This is the KEY differentiator in the architecture.
 * It re-reads the actual code for each finding and attempts to DISPROVE it.
 * Findings that can't be disproven pass through; false positives are filtered.
 *
 * Architecture note: This agent has a CLEAN perspective — it doesn't inherit
 * any specialized agent's biases. It sees the findings and the code fresh.
 */
export class VerificationAgent {
  private client: Anthropic;
  private config: ReviewConfig;
  private toolkit: AgentToolkit;

  constructor(config: ReviewConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.anthropic_api_key });
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

      // Run the agentic loop
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: prompt },
      ];

      let verdicts: Array<{
        original_finding_index: number;
        verdict: "confirmed" | "rejected" | "modified";
        reason: string;
        modified_finding?: Finding;
      }> = [];

      let iterations = 0;
      const maxIterations = Math.min(findings.length + 3, 12); // Scale with finding count

      while (iterations < maxIterations) {
        iterations++;

        const response = await this.client.messages.create({
          model: this.config.model_verification,
          max_tokens: 4096,
          system: VERIFICATION_AGENT_PROMPT,
          messages,
          tools: this.toolkit.getToolDefinitions() as Anthropic.Tool[],
        });

        totalTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ContentBlock & { type: "tool_use" } =>
            block.type === "tool_use",
        );

        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text",
        );

        if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
          const text = textBlocks.map((b) => b.text).join("\n");
          verdicts = this.parseVerdicts(text);
          break;
        }

        // Execute tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolBlock of toolUseBlocks) {
          const call: ToolCall = {
            id: toolBlock.id,
            name: toolBlock.name,
            input: toolBlock.input as Record<string, unknown>,
          };
          const result = await this.toolkit.executeTool(call);
          toolResults.push({
            type: "tool_result",
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
          });
        }

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
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
        // "rejected" findings are silently dropped
      }

      // Findings not covered by any verdict are kept (conservative approach)
      const coveredIndices = new Set(verdicts.map((v) => v.original_finding_index));
      for (let i = 0; i < findings.length; i++) {
        if (!coveredIndices.has(i)) {
          // Mark as lower confidence since unverified
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
      // On failure, return all findings with reduced confidence
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
