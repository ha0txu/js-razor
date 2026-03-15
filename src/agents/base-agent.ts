import type {
  ReviewConfig,
  Finding,
  AgentResult,
  FileDiff,
  ToolCall,
} from "../types/index.js";
import type { LLMClient, LLMMessage, LLMContent } from "../providers/types.js";
import { createClient } from "../providers/index.js";
import { AgentToolkit } from "../tools/agent-tools.js";
import { Retriever } from "../rag/retriever.js";
import { buildAgentPrompt } from "../prompts/system-prompts.js";
import { extractJsonArray } from "../utils/json-extract.js";

/**
 * Base class for all review agents.
 * Handles the LLM agentic loop: prompt → tool calls → findings.
 *
 * Provider-agnostic: works with both Claude and Gemini models.
 * The provider is auto-detected from the model name prefix:
 *   - "claude-*" → Anthropic
 *   - "gemini-*" → Google Gemini
 *
 * Each agent:
 * 1. Receives a system prompt specific to its specialty
 * 2. Gets the diff + RAG context
 * 3. Can use tools (read_file, search_codebase, search_pr_history)
 * 4. Returns structured findings as JSON
 *
 * The agentic loop runs until the agent produces its final findings
 * or hits the iteration limit (prevents runaway tool use).
 */
export class BaseReviewAgent {
  protected client: LLMClient;
  protected config: ReviewConfig;
  protected toolkit: AgentToolkit;
  protected retriever: Retriever;

  readonly name: string;
  private systemPrompt: string;
  private agentFocus: string;
  private model: string;
  private maxIterations: number;

  constructor(
    name: string,
    systemPrompt: string,
    agentFocus: string,
    config: ReviewConfig,
    options?: { model?: string; maxIterations?: number },
  ) {
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.agentFocus = agentFocus;
    this.config = config;
    this.model = options?.model ?? config.model_review_agent;
    this.maxIterations = options?.maxIterations ?? 8;

    // Auto-detect provider from model name
    this.client = createClient(config, this.model);
    this.toolkit = new AgentToolkit(config);
    this.retriever = new Retriever(config);
  }

  /**
   * Run the agent on a set of file diffs.
   * Returns structured findings with timing and token stats.
   */
  async review(
    files: FileDiff[],
    projectContext: string,
    reviewRules: string,
    headRef: string,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    try {
      // Set PR context for tools
      this.toolkit.setPRContext(files, headRef);

      // Build RAG context specific to this agent's focus
      const ragContext = await this.retriever.buildAgentContext(
        files,
        this.agentFocus,
        { maxCodeChunks: 6, maxPRs: 3, maxTotalTokens: 4000 },
      );

      // Build the diff content (optimized for token usage)
      const diffContent = files
        .map((f) => `=== ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ===\n${f.patch}`)
        .join("\n\n");

      // Construct full prompt
      const fullPrompt = buildAgentPrompt(
        this.systemPrompt,
        projectContext,
        reviewRules,
        diffContent,
        ragContext,
      );

      // Run the agentic loop (provider-agnostic)
      const messages: LLMMessage[] = [
        { role: "user", content: [{ type: "text", text: fullPrompt }] },
      ];

      let findings: Finding[] = [];
      let iterations = 0;

      while (iterations < this.maxIterations) {
        iterations++;

        const response = await this.client.chat({
          model: this.model,
          max_tokens: 4096,
          system: "You are a code review agent. Always respond with valid JSON when providing findings.",
          messages,
          tools: this.toolkit.getToolDefinitions(),
        });

        totalTokens += response.usage.input_tokens + response.usage.output_tokens;

        // If no tool use, extract findings from the text response
        if (response.tool_calls.length === 0 || response.stop_reason === "end_turn") {
          findings = this.parseFindings(response.text_content);
          break;
        }

        // Build assistant message content (text + tool calls)
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
            // Preserve Gemini thought signature for multi-turn tool use
            ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
          });
        }
        messages.push({ role: "assistant", content: assistantContent });

        // Execute tool calls and add results
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

      return {
        agent_name: this.name,
        findings,
        tokens_used: totalTokens,
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        agent_name: this.name,
        findings: [],
        tokens_used: totalTokens,
        duration_ms: Date.now() - startTime,
        error: `Agent ${this.name} failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Parse the agent's text response into structured findings.
   * Handles various JSON extraction scenarios including:
   *   - Raw JSON array
   *   - JSON wrapped in markdown code blocks (```json ... ```)
   *   - JSON preceded/followed by explanatory text
   *   - Gemini thinking models that include reasoning before the JSON
   */
  private parseFindings(text: string): Finding[] {
    try {
      const jsonStr = extractJsonArray(text);
      if (!jsonStr) {
        console.warn(`  [${this.name}] No JSON array found in response. Raw text (first 500 chars):\n${text.slice(0, 500)}`);
        return [];
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.warn(`  [${this.name}] Parsed JSON is not an array. Type: ${typeof parsed}`);
        return [];
      }

      // Validate and normalize each finding
      const findings = parsed
        .filter((f: Record<string, unknown>) =>
          f.file && f.line_start && f.severity && f.title && f.description,
        )
        .map((f: Record<string, unknown>) => ({
          file: String(f.file),
          line_start: Number(f.line_start),
          line_end: Number(f.line_end ?? f.line_start),
          severity: normalizeSeverity(String(f.severity)),
          category: normalizeCategory(String(f.category ?? "logic-error")),
          title: String(f.title),
          description: String(f.description),
          code_snippet: String(f.code_snippet ?? ""),
          suggestion: f.suggestion ? String(f.suggestion) : undefined,
          confidence: Math.min(1, Math.max(0, Number(f.confidence ?? 0.5))),
          similar_pr_reference: f.similar_pr_reference ? String(f.similar_pr_reference) : undefined,
        })) as Finding[];

      console.log(`  [${this.name}] Parsed ${findings.length} findings from ${parsed.length} raw items`);
      return findings;
    } catch (e) {
      console.warn(`  [${this.name}] Failed to parse findings: ${(e as Error).message}`);
      console.warn(`  [${this.name}] Raw response (first 1000 chars):\n${text.slice(0, 1000)}`);
      return [];
    }
  }

}

function normalizeSeverity(s: string): Finding["severity"] {
  const valid = ["critical", "warning", "suggestion", "nitpick"];
  return valid.includes(s) ? (s as Finding["severity"]) : "suggestion";
}

function normalizeCategory(c: string): Finding["category"] {
  const valid = [
    "logic-error", "security", "performance", "react-pattern",
    "node-pattern", "typescript", "error-handling", "edge-case",
    "architecture", "testing",
  ];
  return valid.includes(c) ? (c as Finding["category"]) : "logic-error";
}
