/**
 * Provider-agnostic types for LLM interaction.
 * This abstraction allows switching between Claude and Gemini
 * without changing any agent logic.
 */

export type LLMProvider = "anthropic" | "gemini";

export interface LLMMessage {
  role: "user" | "assistant";
  content: LLMContent[];
}

export type LLMContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; thought_signature?: string }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  text_content: string;
  tool_calls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    /** Gemini thought signature — must be preserved and sent back in the next turn */
    thought_signature?: string;
  }>;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  /** The raw provider-specific response for advanced use cases */
  raw?: unknown;
}

export interface LLMRequestOptions {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  max_tokens?: number;
  temperature?: number;
}

/**
 * Unified interface for LLM providers.
 * Implementations must normalize provider-specific responses
 * into the common LLMResponse format.
 */
export interface LLMClient {
  readonly provider: LLMProvider;

  /**
   * Send a message and get a response.
   * Handles tool-use responses transparently.
   */
  chat(options: LLMRequestOptions): Promise<LLMResponse>;
}
