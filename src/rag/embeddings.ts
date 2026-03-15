import OpenAI from "openai";
import type { ReviewConfig } from "../types/index.js";

/**
 * Embedding service using OpenAI's text-embedding-3-small model.
 * Supports batched embedding generation with automatic chunking
 * to stay within API limits.
 */
export class EmbeddingService {
  private client: OpenAI;
  private model: string;
  private readonly MAX_BATCH_SIZE = 100;

  constructor(config: ReviewConfig) {
    this.client = new OpenAI({ apiKey: config.openai_api_key });
    this.model = config.embedding_model;
  }

  /**
   * Generate embedding for a single text string.
   */
  async embed(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: this.model,
      input: truncateForEmbedding(text),
    });
    return result.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * Returns embeddings in the same order as input.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + this.MAX_BATCH_SIZE).map(truncateForEmbedding);
      const result = await this.client.embeddings.create({
        model: this.model,
        input: batch,
      });
      // Sort by index to guarantee order
      const sorted = result.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));
    }

    return allEmbeddings;
  }
}

/**
 * Truncate text to fit within embedding model token limits.
 * text-embedding-3-small supports 8191 tokens.
 * Rough estimate: 1 token ≈ 4 chars for code.
 */
function truncateForEmbedding(text: string, maxChars = 28000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... [truncated]";
}
