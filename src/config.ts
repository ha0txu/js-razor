import "dotenv/config";
import type { ReviewConfig } from "./types/index.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function loadConfig(overrides?: Partial<ReviewConfig>): ReviewConfig {
  return {
    anthropic_api_key: requireEnv("ANTHROPIC_API_KEY"),
    openai_api_key: requireEnv("OPENAI_API_KEY"),
    github_token: requireEnv("GITHUB_TOKEN"),
    github_owner: overrides?.github_owner ?? requireEnv("GITHUB_OWNER"),
    github_repo: overrides?.github_repo ?? requireEnv("GITHUB_REPO"),

    model_orchestrator: optionalEnv("MODEL_ORCHESTRATOR", "claude-sonnet-4-20250514"),
    model_review_agent: optionalEnv("MODEL_REVIEW_AGENT", "claude-sonnet-4-20250514"),
    model_verification: optionalEnv("MODEL_VERIFICATION", "claude-sonnet-4-20250514"),
    model_simple_review: optionalEnv("MODEL_SIMPLE_REVIEW", "claude-haiku-4-5-20251001"),
    embedding_model: optionalEnv("EMBEDDING_MODEL", "text-embedding-3-small"),

    max_tokens_per_review: parseInt(optionalEnv("MAX_TOKENS_PER_REVIEW", "200000")),
    max_review_time_ms: parseInt(optionalEnv("MAX_REVIEW_TIME_MS", "300000")),
    max_findings_before_escalation: parseInt(optionalEnv("MAX_FINDINGS_BEFORE_ESCALATION", "25")),

    vector_store_path: optionalEnv("VECTOR_STORE_PATH", "./.vector-store"),
    repo_path: overrides?.repo_path ?? process.cwd(),

    ...overrides,
  };
}
