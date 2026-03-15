import OpenAI from "openai";
import type { ReviewConfig } from "../types/index.js";

/**
 * Embedding provider interface.
 * Both OpenAI and Gemini implement this to provide a unified API.
 */
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ─── OpenAI Provider ─────────────────────────────────────────────────────────

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private readonly MAX_BATCH_SIZE = 100;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: this.model,
      input: truncateForEmbedding(text),
    });
    return result.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + this.MAX_BATCH_SIZE).map(truncateForEmbedding);
      const result = await this.client.embeddings.create({
        model: this.model,
        input: batch,
      });
      const sorted = result.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));
    }

    return allEmbeddings;
  }
}

// ─── Gemini Provider ─────────────────────────────────────────────────────────

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiEmbedResponse {
  embedding: { values: number[] };
}

interface GeminiBatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

class GeminiEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private readonly MAX_BATCH_SIZE = 100;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const url = `${GEMINI_EMBED_URL}/${this.model}:embedContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text: truncateForEmbedding(text) }] },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini Embedding API error ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = (await response.json()) as GeminiEmbedResponse;
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + this.MAX_BATCH_SIZE);
      const embeddings = await this.batchRequest(batch);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  private async batchRequest(texts: string[]): Promise<number[][]> {
    const url = `${GEMINI_EMBED_URL}/${this.model}:batchEmbedContents?key=${this.apiKey}`;

    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text: truncateForEmbedding(text) }] },
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini Batch Embedding API error ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = (await response.json()) as GeminiBatchEmbedResponse;
    return data.embeddings.map((e) => e.values);
  }
}

// ─── Unified Service ─────────────────────────────────────────────────────────

/**
 * Provider-agnostic embedding service.
 *
 * Auto-detects provider from the embedding model name:
 *   - "text-embedding-*"        → OpenAI  (needs OPENAI_API_KEY)
 *   - "text-embedding-004" etc  → Gemini  (needs GEMINI_API_KEY)
 *
 * Supported models:
 *   OpenAI:  text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
 *   Gemini:  gemini-embedding-001, text-embedding-004
 */
export class EmbeddingService {
  private provider: EmbeddingProvider;

  constructor(config: ReviewConfig) {
    const model = config.embedding_model;

    if (isGeminiEmbeddingModel(model)) {
      if (!config.gemini_api_key) {
        throw new Error(
          `Gemini embedding model "${model}" requires GEMINI_API_KEY. ` +
          `Set it in .env or use an OpenAI model like "text-embedding-3-small".`,
        );
      }
      this.provider = new GeminiEmbeddingProvider(config.gemini_api_key, model);
    } else {
      if (!config.openai_api_key) {
        throw new Error(
          `OpenAI embedding model "${model}" requires OPENAI_API_KEY. ` +
          `Set it in .env or use a Gemini model like "gemini-embedding-001".`,
        );
      }
      this.provider = new OpenAIEmbeddingProvider(config.openai_api_key, model);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.provider.embedBatch(texts);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GEMINI_EMBEDDING_MODELS = [
  "gemini-embedding-001",
  "text-embedding-004",
  "embedding-001",
];

function isGeminiEmbeddingModel(model: string): boolean {
  return GEMINI_EMBEDDING_MODELS.includes(model) || model.startsWith("gemini-embedding-");
}

/**
 * Truncate text to fit within embedding model token limits.
 *   OpenAI text-embedding-3-small: 8191 tokens
 *   Gemini text-embedding-004:     2048 tokens
 *   Gemini gemini-embedding-001:   8192 tokens
 * Rough estimate: 1 token ≈ 4 chars for code.
 */
function truncateForEmbedding(text: string, maxChars = 28000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... [truncated]";
}
