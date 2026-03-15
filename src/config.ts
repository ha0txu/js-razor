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

/**
 * Gemini embedding model names — used to detect if OpenAI key is needed.
 */
const GEMINI_EMBEDDING_MODELS = [
  "gemini-embedding-001",
  "text-embedding-004",
  "embedding-001",
];

function isGeminiEmbeddingModel(model: string): boolean {
  return GEMINI_EMBEDDING_MODELS.includes(model) || model.startsWith("gemini-embedding-");
}

export function loadConfig(overrides?: Partial<ReviewConfig>): ReviewConfig {
  const modelReview = optionalEnv("MODEL_REVIEW_AGENT", "claude-sonnet-4-20250514");
  const modelSimple = optionalEnv("MODEL_SIMPLE_REVIEW", "claude-haiku-4-5-20251001");
  const embeddingModel = optionalEnv("EMBEDDING_MODEL", "text-embedding-3-small");

  // Detect which LLM providers are needed
  const allModels = [
    modelReview,
    modelSimple,
    optionalEnv("MODEL_ORCHESTRATOR", modelReview),
    optionalEnv("MODEL_VERIFICATION", modelReview),
  ];
  const needsGemini = allModels.some((m) => detectProvider(m) === "gemini") || isGeminiEmbeddingModel(embeddingModel);
  const needsAnthropic = allModels.some((m) => detectProvider(m) === "anthropic");
  const needsOpenAI = !isGeminiEmbeddingModel(embeddingModel);

  // Only require API keys for providers that are actually used
  const anthropicKey = needsAnthropic
    ? requireEnv("ANTHROPIC_API_KEY")
    : process.env["ANTHROPIC_API_KEY"] ?? "";
  const geminiKey = needsGemini
    ? requireEnv("GEMINI_API_KEY")
    : process.env["GEMINI_API_KEY"] ?? undefined;
  const openaiKey = needsOpenAI
    ? requireEnv("OPENAI_API_KEY")
    : process.env["OPENAI_API_KEY"] ?? undefined;

  return {
    anthropic_api_key: anthropicKey,
    gemini_api_key: geminiKey,
    openai_api_key: openaiKey,
    github_token: requireEnv("GITHUB_TOKEN"),
    github_owner: overrides?.github_owner ?? requireEnv("GITHUB_OWNER"),
    github_repo: overrides?.github_repo ?? requireEnv("GITHUB_REPO"),

    model_orchestrator: optionalEnv("MODEL_ORCHESTRATOR", modelReview),
    model_review_agent: modelReview,
    model_verification: optionalEnv("MODEL_VERIFICATION", modelReview),
    model_simple_review: modelSimple,
    embedding_model: embeddingModel,

    max_tokens_per_review: parseInt(optionalEnv("MAX_TOKENS_PER_REVIEW", "200000")),
    max_review_time_ms: parseInt(optionalEnv("MAX_REVIEW_TIME_MS", "300000")),
    max_findings_before_escalation: parseInt(optionalEnv("MAX_FINDINGS_BEFORE_ESCALATION", "25")),

    vector_store_path: optionalEnv("VECTOR_STORE_PATH", "./.vector-store"),
    repo_path: overrides?.repo_path ?? process.cwd(),

    ...overrides,
  };
}
