import "dotenv/config";
import type { ReviewConfig } from "./types/index.js";
import { detectProvider } from "./providers/index.js";

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
  const modelReview = optionalEnv("MODEL_REVIEW_AGENT", "claude-sonnet-4-20250514");
  const modelSimple = optionalEnv("MODEL_SIMPLE_REVIEW", "claude-haiku-4-5-20251001");

  // Detect if any configured model uses Gemini
  const allModels = [
    modelReview,
    modelSimple,
    optionalEnv("MODEL_ORCHESTRATOR", modelReview),
    optionalEnv("MODEL_VERIFICATION", modelReview),
  ];
  const needsGemini = allModels.some((m) => detectProvider(m) === "gemini");
  const needsAnthropic = allModels.some((m) => detectProvider(m) === "anthropic");

  // Only require API keys for providers that are actually used
  const anthropicKey = needsAnthropic
    ? requireEnv("ANTHROPIC_API_KEY")
    : process.env["ANTHROPIC_API_KEY"] ?? "";
  const geminiKey = needsGemini
    ? requireEnv("GEMINI_API_KEY")
    : process.env["GEMINI_API_KEY"] ?? undefined;

  return {
    anthropic_api_key: anthropicKey,
    gemini_api_key: geminiKey,
    openai_api_key: requireEnv("OPENAI_API_KEY"),
    github_token: requireEnv("GITHUB_TOKEN"),
    github_owner: overrides?.github_owner ?? requireEnv("GITHUB_OWNER"),
    github_repo: overrides?.github_repo ?? requireEnv("GITHUB_REPO"),

    model_orchestrator: optionalEnv("MODEL_ORCHESTRATOR", modelReview),
    model_review_agent: modelReview,
    model_verification: optionalEnv("MODEL_VERIFICATION", modelReview),
    model_simple_review: modelSimple,
    embedding_model: optionalEnv("EMBEDDING_MODEL", "text-embedding-3-small"),

    max_tokens_per_review: parseInt(optionalEnv("MAX_TOKENS_PER_REVIEW", "200000")),
    max_review_time_ms: parseInt(optionalEnv("MAX_REVIEW_TIME_MS", "300000")),
    max_findings_before_escalation: parseInt(optionalEnv("MAX_FINDINGS_BEFORE_ESCALATION", "25")),

    vector_store_path: optionalEnv("VECTOR_STORE_PATH", "./.vector-store"),
    repo_path: overrides?.repo_path ?? process.cwd(),

    ...overrides,
  };
}
