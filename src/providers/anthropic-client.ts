import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMClient,
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMMessage,
} from "./types.js";

/**
 * Anthropic Claude provider implementation.
 * Wraps the @anthropic-ai/sdk into the unified LLMClient interface.
 */
export class AnthropicClient implements LLMClient {
  readonly provider: LLMProvider = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is required when using Claude models. " +
        "Set it in your .env file or environment variables.",
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.max_tokens ?? 4096,
      ...(options.system ? { system: options.system } : {}),
      messages: this.toAnthropicMessages(options.messages),
      ...(options.tools?.length
        ? { tools: options.tools as Anthropic.Tool[] }
        : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
    });

    return this.normalizeResponse(response);
  }

  private toAnthropicMessages(
    messages: LLMMessage[],
  ): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      // Simple text-only message
      if (
        msg.content.length === 1 &&
        msg.content[0].type === "text"
      ) {
        return { role: msg.role, content: msg.content[0].text };
      }

      // Complex multi-part message
      const content: Anthropic.ContentBlockParam[] = msg.content.map((c) => {
        switch (c.type) {
          case "text":
            return { type: "text" as const, text: c.text };
          case "tool_use":
            return {
              type: "tool_use" as const,
              id: c.id,
              name: c.name,
              input: c.input,
            };
          case "tool_result":
            return {
              type: "tool_result" as const,
              tool_use_id: c.tool_use_id,
              content: c.content,
              is_error: c.is_error,
            };
        }
      });

      return { role: msg.role, content };
    });
  }

  private normalizeResponse(response: Anthropic.Message): LLMResponse {
    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);

    const toolCalls = response.content
      .filter(
        (b): b is Anthropic.ContentBlock & { type: "tool_use" } =>
          b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

    let stopReason: LLMResponse["stop_reason"];
    switch (response.stop_reason) {
      case "end_turn":
        stopReason = "end_turn";
        break;
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        break;
      default:
        stopReason = "other";
    }

    return {
      text_content: textBlocks.join("\n"),
      tool_calls: toolCalls,
      stop_reason: stopReason,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      },
      raw: response,
    };
  }
}
