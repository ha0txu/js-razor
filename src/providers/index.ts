export { AnthropicClient } from "./anthropic-client.js";
export { GeminiClient } from "./gemini-client.js";
export type {
  LLMClient,
  LLMProvider,
  LLMMessage,
  LLMContent,
  LLMResponse,
  LLMRequestOptions,
  LLMToolDefinition,
} from "./types.js";

import type { LLMClient, LLMProvider } from "./types.js";
import type { ReviewConfig } from "../types/index.js";
import { AnthropicClient } from "./anthropic-client.js";
import { GeminiClient } from "./gemini-client.js";

/**
 * Model name → provider mapping.
 * Automatically detects the provider from the model string.
 */
const MODEL_PROVIDER_MAP: Array<{ pattern: RegExp; provider: LLMProvider }> = [
  { pattern: /^claude-/, provider: "anthropic" },
  { pattern: /^gemini-/, provider: "gemini" },
];

export function detectProvider(model: string): LLMProvider {
  for (const { pattern, provider } of MODEL_PROVIDER_MAP) {
    if (pattern.test(model)) return provider;
  }
  // Default to anthropic for unknown models
  return "anthropic";
}

/**
 * Create an LLM client for the given model name.
 * Automatically picks the right provider based on the model prefix.
 *
 * Usage:
 *   const client = createClient(config, "claude-sonnet-4-20250514");  // → AnthropicClient
 *   const client = createClient(config, "gemini-2.5-pro");             // → GeminiClient
 */
export function createClient(config: ReviewConfig, model: string): LLMClient {
  const provider = detectProvider(model);
  return createClientForProvider(config, provider);
}

/**
 * Create an LLM client for a specific provider.
 */
export function createClientForProvider(
  config: ReviewConfig,
  provider: LLMProvider,
): LLMClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicClient(config.anthropic_api_key);
    case "gemini":
      if (!config.gemini_api_key) {
        throw new Error(
          "GEMINI_API_KEY is required when using Gemini models. " +
          "Set it in your .env file or environment variables.",
        );
      }
      return new GeminiClient(config.gemini_api_key);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
