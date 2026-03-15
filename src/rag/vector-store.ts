import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Lightweight local vector store using cosine similarity.
 * Stores vectors + metadata as JSON files on disk.
 * No external database dependency — suitable for single-repo use cases.
 *
 * For production at scale, replace with pgvector, Pinecone, or Qdrant.
 */

interface StoredItem {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  text: string;
}

interface VectorIndex {
  items: StoredItem[];
  dimension: number;
  created_at: string;
  updated_at: string;
}

export class LocalVectorStore {
  private indexPath: string;
  private index: VectorIndex;

  constructor(storePath: string, private namespace: string) {
    this.indexPath = path.join(storePath, `${namespace}.json`);
    this.index = this.loadOrCreate();
  }

  private loadOrCreate(): VectorIndex {
    if (fs.existsSync(this.indexPath)) {
      const data = fs.readFileSync(this.indexPath, "utf-8");
      return JSON.parse(data) as VectorIndex;
    }
    return {
      items: [],
      dimension: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  private save(): void {
    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.index.updated_at = new Date().toISOString();
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index));
  }

  /**
   * Upsert items into the store. If an item with the same ID exists, it's replaced.
   */
  upsert(items: Array<{ id: string; vector: number[]; metadata: Record<string, unknown>; text: string }>): void {
    const existingIds = new Set(this.index.items.map((i) => i.id));

    for (const item of items) {
      if (this.index.dimension === 0) {
        this.index.dimension = item.vector.length;
      }
      if (existingIds.has(item.id)) {
        const idx = this.index.items.findIndex((i) => i.id === item.id);
        this.index.items[idx] = item;
      } else {
        this.index.items.push(item);
      }
    }

    this.save();
  }

  /**
   * Query the store for the top-k most similar vectors.
   */
  query(
    vector: number[],
    topK: number = 10,
    filter?: (metadata: Record<string, unknown>) => boolean,
  ): Array<{ id: string; score: number; metadata: Record<string, unknown>; text: string }> {
    let candidates = this.index.items;

    if (filter) {
      candidates = candidates.filter((item) => filter(item.metadata));
    }

    const scored = candidates.map((item) => ({
      id: item.id,
      score: cosineSimilarity(vector, item.vector),
      metadata: item.metadata,
      text: item.text,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Delete items by ID.
   */
  delete(ids: string[]): void {
    const idsToDelete = new Set(ids);
    this.index.items = this.index.items.filter((i) => !idsToDelete.has(i.id));
    this.save();
  }

  /**
   * Clear all items in this namespace.
   */
  clear(): void {
    this.index.items = [];
    this.save();
  }

  get size(): number {
    return this.index.items.length;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}
