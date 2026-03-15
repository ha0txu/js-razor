import type {
  LLMClient,
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMMessage,
  LLMToolDefinition,
} from "./types.js";

/**
 * Google Gemini provider implementation.
 * Uses the Gemini REST API directly — no SDK dependency needed.
 *
 * Supports:
 *   - gemini-2.5-pro
 *   - gemini-2.5-flash
 *   - gemini-2.0-flash
 *   - gemini-1.5-pro / gemini-1.5-flash
 *
 * Tool use (function calling) is fully supported via Gemini's
 * native function_declarations API.
 */

// ─── Gemini API Types ────────────────────────────────────────────────────────

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { content: unknown } } };

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

interface GeminiCandidate {
  content: {
    role: string;
    parts: GeminiPart[];
  };
  finishReason: string;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ─── Client Implementation ───────────────────────────────────────────────────

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiClient implements LLMClient {
  readonly provider: LLMProvider = "gemini";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const url = `${GEMINI_API_BASE}/${options.model}:generateContent?key=${this.apiKey}`;

    const body: GeminiRequest = {
      contents: this.toGeminiContents(options.messages),
    };

    if (options.system) {
      body.systemInstruction = {
        parts: [{ text: options.system }],
      };
    }

    if (options.tools?.length) {
      body.tools = [this.toGeminiTools(options.tools)];
    }

    body.generationConfig = {
      maxOutputTokens: options.max_tokens ?? 4096,
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Gemini API error ${response.status}: ${errorBody.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as GeminiResponse;
    return this.normalizeResponse(data);
  }

  // ─── Message Conversion ──────────────────────────────────────────────

  private toGeminiContents(messages: LLMMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      const role = msg.role === "assistant" ? "model" : "user";
      const parts: GeminiPart[] = [];

      for (const c of msg.content) {
        switch (c.type) {
          case "text":
            parts.push({ text: c.text });
            break;
          case "tool_use": {
            // Model's function calls (in assistant messages)
            // Preserve thoughtSignature if present (required by Gemini 3+ models)
            const fcPart: GeminiPart = {
              functionCall: { name: c.name, args: c.input },
            };
            if (c.thought_signature) {
              (fcPart as { functionCall: unknown; thoughtSignature?: string }).thoughtSignature = c.thought_signature;
            }
            parts.push(fcPart);
            break;
          }
          case "tool_result":
            // User's function responses
            parts.push({
              functionResponse: {
                name: this.findToolName(messages, c.tool_use_id),
                response: { content: c.content },
              },
            });
            break;
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }

  /**
   * Find the tool name that corresponds to a tool_use_id.
   * Gemini's functionResponse needs the function name, not an ID.
   */
  private findToolName(messages: LLMMessage[], toolUseId: string): string {
    for (const msg of messages) {
      for (const c of msg.content) {
        if (c.type === "tool_use" && c.id === toolUseId) {
          return c.name;
        }
      }
    }
    return "unknown_tool";
  }

  // ─── Tool Conversion ─────────────────────────────────────────────────

  private toGeminiTools(tools: LLMToolDefinition[]): GeminiTool {
    return {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: this.cleanSchema(t.input_schema),
      })),
    };
  }

  /**
   * Clean JSON Schema for Gemini compatibility.
   * Gemini doesn't accept some OpenAPI/JSON Schema features that Claude uses.
   */
  private cleanSchema(
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    const cleaned = { ...schema };
    // Gemini doesn't support 'additionalProperties'
    delete cleaned.additionalProperties;
    // Recursively clean nested properties
    if (cleaned.properties && typeof cleaned.properties === "object") {
      const props = cleaned.properties as Record<
        string,
        Record<string, unknown>
      >;
      for (const key of Object.keys(props)) {
        props[key] = this.cleanSchema(props[key]);
      }
    }
    if (cleaned.items && typeof cleaned.items === "object") {
      cleaned.items = this.cleanSchema(
        cleaned.items as Record<string, unknown>,
      );
    }
    return cleaned;
  }

  // ─── Response Normalization ──────────────────────────────────────────

  private normalizeResponse(response: GeminiResponse): LLMResponse {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      return {
        text_content: "",
        tool_calls: [],
        stop_reason: "other",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    const parts = candidate.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: LLMResponse["tool_calls"] = [];

    for (const part of parts) {
      if ("text" in part) {
        textParts.push(part.text);
      } else if ("functionCall" in part) {
        toolCalls.push({
          // Generate a unique ID since Gemini doesn't provide one
          id: `gemini_tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          input: part.functionCall.args,
          // Preserve thought signature (required by Gemini 3+ models for multi-turn tool use)
          thought_signature: (part as { thoughtSignature?: string }).thoughtSignature,
        });
      }
    }

    let stopReason: LLMResponse["stop_reason"];
    switch (candidate.finishReason) {
      case "STOP":
        stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
        break;
      case "MAX_TOKENS":
        stopReason = "max_tokens";
        break;
      default:
        stopReason = toolCalls.length > 0 ? "tool_use" : "other";
    }

    return {
      text_content: textParts.join("\n"),
      tool_calls: toolCalls,
      stop_reason: stopReason,
      usage: {
        input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: response,
    };
  }
}
