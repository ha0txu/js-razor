import { z } from "zod";

// ─── Review Finding Schema ───────────────────────────────────────────────────

export const SeveritySchema = z.enum(["critical", "warning", "suggestion", "nitpick"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  "logic-error",
  "security",
  "performance",
  "react-pattern",
  "node-pattern",
  "typescript",
  "error-handling",
  "edge-case",
  "architecture",
  "testing",
]);
export type Category = z.infer<typeof CategorySchema>;

export const FindingSchema = z.object({
  file: z.string().describe("Relative file path"),
  line_start: z.number().describe("Starting line number of the issue"),
  line_end: z.number().describe("Ending line number of the issue"),
  severity: SeveritySchema,
  category: CategorySchema,
  title: z.string().describe("One-line summary of the issue"),
  description: z.string().describe("Detailed explanation of the problem"),
  code_snippet: z.string().describe("The problematic code"),
  suggestion: z.string().optional().describe("Suggested fix or improvement"),
  confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
  similar_pr_reference: z.string().optional().describe("Reference to a similar past PR/bugfix"),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AgentResultSchema = z.object({
  agent_name: z.string(),
  findings: z.array(FindingSchema),
  tokens_used: z.number(),
  duration_ms: z.number(),
  error: z.string().optional(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ─── PR Types ────────────────────────────────────────────────────────────────

export interface PRMetadata {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  author: string;
  base_branch: string;
  head_branch: string;
  created_at: string;
  labels: string[];
}

export interface FileDiff {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string;         // The unified diff
  raw_content?: string;  // Full file content (loaded on demand)
}

export interface PRData {
  metadata: PRMetadata;
  files: FileDiff[];
  total_additions: number;
  total_deletions: number;
  total_files_changed: number;
}

// ─── Complexity Assessment ───────────────────────────────────────────────────

export type ComplexityLevel = "trivial" | "standard" | "complex" | "critical";

export interface ComplexityAssessment {
  level: ComplexityLevel;
  reasons: string[];
  agents_to_dispatch: AgentType[];
  model_tier: "haiku" | "sonnet" | "opus";
}

export type AgentType =
  | "logic"
  | "security"
  | "performance"
  | "react-patterns"
  | "edge-cases";

// ─── RAG Types ───────────────────────────────────────────────────────────────

export interface CodeChunk {
  id: string;
  file_path: string;
  content: string;
  type: "function" | "class" | "component" | "module" | "hook" | "route" | "middleware" | "test";
  name: string;
  start_line: number;
  end_line: number;
  exports: string[];
  imports: string[];
}

export interface PRHistoryEntry {
  id: string;
  pr_number: number;
  title: string;
  description: string;
  author: string;
  merged_at: string;
  labels: string[];
  files_changed: string[];
  diff_summary: string;    // Condensed diff
  review_comments: string; // Concatenated review comments
  is_bugfix: boolean;
  bug_description?: string;
  fix_description?: string;
}

export interface RetrievalResult {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  source: "code" | "pr-history";
}

// ─── Agent Tool Types ────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ReviewConfig {
  anthropic_api_key: string;
  gemini_api_key?: string;
  openai_api_key: string;
  github_token: string;
  github_owner: string;
  github_repo: string;

  model_orchestrator: string;
  model_review_agent: string;
  model_verification: string;
  model_simple_review: string;
  embedding_model: string;

  max_tokens_per_review: number;
  max_review_time_ms: number;
  max_findings_before_escalation: number;

  vector_store_path: string;
  repo_path: string;
}

// ─── Final Review Output ─────────────────────────────────────────────────────

export interface ReviewOutput {
  pr: PRMetadata;
  complexity: ComplexityAssessment;
  findings: Finding[];
  summary: string;
  stats: {
    total_findings: number;
    by_severity: Record<Severity, number>;
    by_category: Record<string, number>;
    agents_run: string[];
    total_tokens: number;
    total_duration_ms: number;
    findings_before_verification: number;
    findings_after_verification: number;
  };
}
