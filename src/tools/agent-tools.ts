import * as fs from "node:fs";
import * as path from "node:path";
import { Retriever } from "../rag/retriever.js";
import { GitHubClient } from "../github/client.js";
import type { ReviewConfig, ToolDefinition, ToolCall, ToolResult, FileDiff } from "../types/index.js";

/**
 * Tools available to review agents during analysis.
 * These are registered as Claude tool-use functions.
 *
 * Tools follow Anthropic's ACI design principles:
 * - Clear, descriptive names
 * - Minimal required parameters
 * - Flexible detail_level to control token usage
 * - Error messages that help the agent recover
 */

export class AgentToolkit {
  private retriever: Retriever;
  private github: GitHubClient;
  private config: ReviewConfig;
  private prFiles: Map<string, FileDiff> = new Map();
  private headRef: string = "HEAD";

  constructor(config: ReviewConfig) {
    this.config = config;
    this.retriever = new Retriever(config);
    this.github = new GitHubClient(config);
  }

  /**
   * Set the current PR context so tools know which files are in scope.
   */
  setPRContext(files: FileDiff[], headRef: string): void {
    this.prFiles.clear();
    for (const f of files) {
      this.prFiles.set(f.filename, f);
    }
    this.headRef = headRef;
  }

  // ─── Tool Definitions (for Claude API) ─────────────────────────────────

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "read_file",
        description:
          "Read the full content of a file from the repository at the PR's head commit. " +
          "Use this when you need to see the complete file to understand context beyond the diff. " +
          "Only request files that are relevant to your review.",
        input_schema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Relative path to the file (e.g., 'src/components/Button.tsx')",
            },
            line_start: {
              type: "number",
              description: "Optional: start line to read from (1-indexed). Omit to read full file.",
            },
            line_end: {
              type: "number",
              description: "Optional: end line to read to (inclusive). Omit to read to end of file.",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "search_codebase",
        description:
          "Search the codebase for code related to a query. Uses semantic search over indexed code chunks. " +
          "Good for finding: callers of a function, similar patterns, related components, middleware, hooks. " +
          "Returns code snippets with file paths and line numbers.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Natural language query describing what you're looking for. " +
                "Be specific, e.g., 'functions that call processPayment' or 'React hooks that manage auth state'",
            },
            type_filter: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional: filter results by code type. Values: 'function', 'class', 'component', 'hook', 'route', 'middleware', 'test', 'module'",
            },
            detail_level: {
              type: "string",
              enum: ["concise", "detailed"],
              description:
                "concise = file paths + function signatures only (saves tokens). " +
                "detailed = full code bodies. Default: concise.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "search_pr_history",
        description:
          "Search past merged PRs for similar changes, bugfixes, or review comments. " +
          "CRITICAL: Use this to find past bugs in similar code — learning from history prevents repeat mistakes. " +
          "Bugfix PRs include the original bug description and fix pattern.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Describe what you're looking for. Examples: " +
                "'bugs related to useEffect cleanup', " +
                "'authentication bypass fixes', " +
                "'race conditions in data fetching'",
            },
            bugfix_only: {
              type: "boolean",
              description: "If true, only return PRs that were bugfixes. Default: false.",
            },
            file_filter: {
              type: "array",
              items: { type: "string" },
              description: "Optional: only return PRs that touched these files.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_dependents",
        description:
          "Find code that imports or depends on the files changed in this PR. " +
          "Use this to understand the blast radius of the changes — " +
          "who will be affected if the changed code has a bug?",
        input_schema: {
          type: "object",
          properties: {
            file_paths: {
              type: "array",
              items: { type: "string" },
              description: "File paths to find dependents for. If empty, uses all files in the PR.",
            },
          },
          required: [],
        },
      },
    ];
  }

  // ─── Tool Execution ────────────────────────────────────────────────────

  async executeTool(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "read_file":
          return await this.handleReadFile(call);
        case "search_codebase":
          return await this.handleSearchCodebase(call);
        case "search_pr_history":
          return await this.handleSearchPRHistory(call);
        case "get_dependents":
          return await this.handleGetDependents(call);
        default:
          return {
            tool_use_id: call.id,
            content: `Unknown tool: ${call.name}`,
            is_error: true,
          };
      }
    } catch (error) {
      return {
        tool_use_id: call.id,
        content: `Tool error: ${(error as Error).message}`,
        is_error: true,
      };
    }
  }

  private async handleReadFile(call: ToolCall): Promise<ToolResult> {
    const filePath = call.input.file_path as string;
    const lineStart = call.input.line_start as number | undefined;
    const lineEnd = call.input.line_end as number | undefined;

    // Security: only allow reading files in the repo
    if (filePath.includes("..") || path.isAbsolute(filePath)) {
      return {
        tool_use_id: call.id,
        content: "Error: File path must be relative and within the repository.",
        is_error: true,
      };
    }

    // Try local file first, then GitHub API
    let content: string;
    const localPath = path.join(this.config.repo_path, filePath);
    if (fs.existsSync(localPath)) {
      content = fs.readFileSync(localPath, "utf-8");
    } else {
      content = await this.github.fetchFileContent(filePath, this.headRef);
    }

    if (!content) {
      return {
        tool_use_id: call.id,
        content: `File not found: ${filePath}`,
        is_error: true,
      };
    }

    // Apply line range if specified
    if (lineStart || lineEnd) {
      const lines = content.split("\n");
      const start = (lineStart ?? 1) - 1;
      const end = lineEnd ?? lines.length;
      content = lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
    }

    // Truncate very large files
    if (content.length > 15000) {
      content = content.slice(0, 15000) + "\n... [truncated — request specific line range for full content]";
    }

    return { tool_use_id: call.id, content };
  }

  private async handleSearchCodebase(call: ToolCall): Promise<ToolResult> {
    const query = call.input.query as string;
    const typeFilter = call.input.type_filter as string[] | undefined;
    const detailLevel = (call.input.detail_level as string) ?? "concise";

    const results = await this.retriever.findRelatedCode(query, {
      topK: detailLevel === "concise" ? 10 : 5,
      typeFilter,
    });

    if (results.length === 0) {
      return { tool_use_id: call.id, content: "No matching code found." };
    }

    const formatted = results.map((r) => {
      const meta = r.metadata;
      if (detailLevel === "concise") {
        // Return just the signature/header
        const firstLine = r.content.split("\n")[0];
        return `[${meta.file_path}:${meta.start_line}] (${meta.type}) ${firstLine}`;
      }
      return `--- ${meta.file_path}:${meta.start_line}-${meta.end_line} (${meta.type}, score: ${(r.score * 100).toFixed(0)}%) ---\n${r.content}`;
    });

    return { tool_use_id: call.id, content: formatted.join("\n\n") };
  }

  private async handleSearchPRHistory(call: ToolCall): Promise<ToolResult> {
    const query = call.input.query as string;
    const bugfixOnly = (call.input.bugfix_only as boolean) ?? false;
    const fileFilter = call.input.file_filter as string[] | undefined;

    const results = await this.retriever.findSimilarPRs(query, {
      topK: 5,
      bugfixOnly,
      fileFilter,
    });

    if (results.length === 0) {
      const suffix = bugfixOnly ? " bugfix" : "";
      return { tool_use_id: call.id, content: `No matching${suffix} PRs found.` };
    }

    const formatted = results.map((r) => r.content);
    return { tool_use_id: call.id, content: formatted.join("\n\n---\n\n") };
  }

  private async handleGetDependents(call: ToolCall): Promise<ToolResult> {
    let filePaths = call.input.file_paths as string[] | undefined;

    const fileDiffs: FileDiff[] = filePaths
      ? filePaths.map((fp) => this.prFiles.get(fp)).filter(Boolean) as FileDiff[]
      : Array.from(this.prFiles.values());

    if (fileDiffs.length === 0) {
      return { tool_use_id: call.id, content: "No matching files found in the PR." };
    }

    const results = await this.retriever.findDependents(fileDiffs);

    if (results.length === 0) {
      return { tool_use_id: call.id, content: "No dependent code found." };
    }

    const formatted = results.map((r) => {
      const meta = r.metadata;
      return `[${meta.file_path}:${meta.start_line}] ${r.content.split("\n")[0]}`;
    });

    return { tool_use_id: call.id, content: formatted.join("\n") };
  }
}
