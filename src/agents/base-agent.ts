import Anthropic from "@anthropic-ai/sdk";
import type {
  ReviewConfig,
  Finding,
  AgentResult,
  FileDiff,
  ToolCall,
} from "../types/index.js";
import { AgentToolkit } from "../tools/agent-tools.js";
import { Retriever } from "../rag/retriever.js";
import { buildAgentPrompt } from "../prompts/system-prompts.js";

/**
 * Base class for all review agents.
 * Handles the Claude API agentic loop: prompt → tool calls → findings.
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
  protected client: Anthropic;
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

    this.client = new Anthropic({ apiKey: config.anthropic_api_key });
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

      // Run the agentic loop
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: fullPrompt },
      ];

      let findings: Finding[] = [];
      let iterations = 0;

      while (iterations < this.maxIterations) {
        iterations++;

        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: "You are a code review agent. Always respond with valid JSON when providing findings.",
          messages,
          tools: this.toolkit.getToolDefinitions() as Anthropic.Tool[],
        });

        totalTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

        // Check for tool use
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ContentBlock & { type: "tool_use" } =>
            block.type === "tool_use",
        );

        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text",
        );

        // If no tool use, extract findings from the text response
        if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
          const text = textBlocks.map((b) => b.text).join("\n");
          findings = this.parseFindings(text);
          break;
        }

        // Execute tool calls and continue the loop
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

        // Add assistant response and tool results to conversation
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
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
   * Handles various JSON extraction scenarios.
   */
  private parseFindings(text: string): Finding[] {
    try {
      // Try to extract JSON array from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      // Validate and normalize each finding
      return parsed
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
    } catch {
      console.warn(`  [${this.name}] Failed to parse findings from response`);
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
