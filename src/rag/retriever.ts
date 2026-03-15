import { EmbeddingService } from "./embeddings.js";
import { LocalVectorStore } from "./vector-store.js";
import type { ReviewConfig, RetrievalResult, FileDiff } from "../types/index.js";

/**
 * Retrieves relevant code context and PR history for review agents.
 *
 * Two retrieval strategies:
 * 1. Code Context — finds related code chunks (callers, tests, similar patterns)
 * 2. PR History — finds similar past PRs, especially bugfixes, for reference
 *
 * Each agent can query with different intents:
 * - "What other code calls this function?" → code context
 * - "Have we seen a similar bug before?" → PR history with bugfix filter
 * - "What patterns does this codebase use?" → code context with type filter
 */
export class Retriever {
  private embeddings: EmbeddingService;
  private codeStore: LocalVectorStore;
  private prStore: LocalVectorStore;

  constructor(config: ReviewConfig) {
    this.embeddings = new EmbeddingService(config);
    this.codeStore = new LocalVectorStore(config.vector_store_path, "code");
    this.prStore = new LocalVectorStore(config.vector_store_path, "pr-history");
  }

  // ─── Code Context Retrieval ────────────────────────────────────────────

  /**
   * Find code related to a specific diff chunk.
   * Used by review agents to understand surrounding context.
   */
  async findRelatedCode(
    query: string,
    options: {
      topK?: number;
      fileFilter?: string[];
      typeFilter?: string[];
      excludeFiles?: string[];
      minScore?: number;
    } = {},
  ): Promise<RetrievalResult[]> {
    const {
      topK = 8,
      fileFilter,
      typeFilter,
      excludeFiles = [],
      minScore = 0.3,
    } = options;

    const queryVector = await this.embeddings.embed(query);

    const results = this.codeStore.query(queryVector, topK * 2, (metadata) => {
      const filePath = metadata.file_path as string;
      const type = metadata.type as string;

      if (excludeFiles.includes(filePath)) return false;
      if (fileFilter && !fileFilter.some((f) => filePath.includes(f))) return false;
      if (typeFilter && !typeFilter.includes(type)) return false;
      return true;
    });

    return results
      .filter((r) => r.score >= minScore)
      .slice(0, topK)
      .map((r) => ({
        content: r.text,
        metadata: r.metadata,
        score: r.score,
        source: "code" as const,
      }));
  }

  /**
   * Find code that imports or uses symbols from the changed files.
   * Helps review agents understand the blast radius of changes.
   */
  async findDependents(fileDiffs: FileDiff[], topK = 10): Promise<RetrievalResult[]> {
    const changedFileNames = fileDiffs.map((f) => {
      const parts = f.filename.split("/");
      return parts[parts.length - 1].replace(/\.(ts|tsx|js|jsx)$/, "");
    });

    const query = `imports from ${changedFileNames.join(", ")}`;
    return this.findRelatedCode(query, {
      topK,
      excludeFiles: fileDiffs.map((f) => f.filename),
    });
  }

  /**
   * Find test files related to the changed code.
   */
  async findRelatedTests(fileDiffs: FileDiff[], topK = 5): Promise<RetrievalResult[]> {
    const fileNames = fileDiffs.map((f) => f.filename).join(", ");
    const query = `tests for ${fileNames}`;

    return this.findRelatedCode(query, {
      topK,
      typeFilter: ["test"],
    });
  }

  // ─── PR History Retrieval ──────────────────────────────────────────────

  /**
   * Find similar past PRs based on the current PR's content.
   * Prioritizes bugfix PRs when the query suggests potential issues.
   */
  async findSimilarPRs(
    query: string,
    options: {
      topK?: number;
      bugfixOnly?: boolean;
      fileFilter?: string[];
      minScore?: number;
    } = {},
  ): Promise<RetrievalResult[]> {
    const {
      topK = 5,
      bugfixOnly = false,
      fileFilter,
      minScore = 0.25,
    } = options;

    const queryVector = await this.embeddings.embed(query);

    const results = this.prStore.query(queryVector, topK * 2, (metadata) => {
      if (bugfixOnly && !metadata.is_bugfix) return false;
      if (fileFilter) {
        const prFiles = metadata.files_changed as string[];
        const hasOverlap = prFiles.some((pf) =>
          fileFilter.some((ff) => pf.includes(ff) || ff.includes(pf)),
        );
        if (!hasOverlap) return false;
      }
      return true;
    });

    return results
      .filter((r) => r.score >= minScore)
      .slice(0, topK)
      .map((r) => ({
        content: r.text,
        metadata: r.metadata,
        score: r.score,
        source: "pr-history" as const,
      }));
  }

  /**
   * Find past bugfix PRs that touched the same files.
   * This is the key RAG feature: learning from past mistakes.
   */
  async findRelevantBugfixes(fileDiffs: FileDiff[], topK = 5): Promise<RetrievalResult[]> {
    const fileNames = fileDiffs.map((f) => f.filename);
    const query = `bugfix in ${fileNames.join(", ")}`;

    return this.findSimilarPRs(query, {
      topK,
      bugfixOnly: true,
      fileFilter: fileNames,
    });
  }

  // ─── Combined Retrieval for Review Agents ──────────────────────────────

  /**
   * Build a complete context package for a review agent.
   * Combines code context, dependent code, tests, and relevant PR history
   * into a single structured context block.
   */
  async buildAgentContext(
    fileDiffs: FileDiff[],
    agentFocus: string,
    options: {
      maxCodeChunks?: number;
      maxPRs?: number;
      maxTotalTokens?: number;
    } = {},
  ): Promise<string> {
    const {
      maxCodeChunks = 8,
      maxPRs = 3,
      maxTotalTokens = 4000,
    } = options;

    // Build a query from the diff content and agent focus
    const diffSummary = fileDiffs
      .map((f) => `${f.filename}: ${f.patch.slice(0, 200)}`)
      .join("\n");
    const query = `${agentFocus}: ${diffSummary}`;

    // Parallel retrieval
    const [relatedCode, dependents, tests, bugfixes, similarPRs] =
      await Promise.all([
        this.findRelatedCode(query, {
          topK: maxCodeChunks,
          excludeFiles: fileDiffs.map((f) => f.filename),
        }),
        this.findDependents(fileDiffs, 5),
        this.findRelatedTests(fileDiffs, 3),
        this.findRelevantBugfixes(fileDiffs, maxPRs),
        this.findSimilarPRs(query, { topK: maxPRs }),
      ]);

    // Build structured context, respecting token budget
    const sections: string[] = [];
    let estimatedTokens = 0;

    // Related code (highest priority)
    if (relatedCode.length > 0) {
      const section = formatSection(
        "Related Code (callers, dependencies, similar patterns)",
        relatedCode,
      );
      const tokens = estimateTokens(section);
      if (estimatedTokens + tokens < maxTotalTokens) {
        sections.push(section);
        estimatedTokens += tokens;
      }
    }

    // Past bugfixes (high priority — this is the key differentiator)
    if (bugfixes.length > 0) {
      const section = formatSection(
        "Past Bugfixes in Related Files (LEARN FROM THESE)",
        bugfixes,
      );
      const tokens = estimateTokens(section);
      if (estimatedTokens + tokens < maxTotalTokens) {
        sections.push(section);
        estimatedTokens += tokens;
      }
    }

    // Dependents (code that imports changed files)
    if (dependents.length > 0) {
      const section = formatSection(
        "Code That Depends On Changed Files (blast radius)",
        dependents,
      );
      const tokens = estimateTokens(section);
      if (estimatedTokens + tokens < maxTotalTokens) {
        sections.push(section);
        estimatedTokens += tokens;
      }
    }

    // Tests
    if (tests.length > 0) {
      const section = formatSection("Existing Tests for Changed Code", tests);
      const tokens = estimateTokens(section);
      if (estimatedTokens + tokens < maxTotalTokens) {
        sections.push(section);
        estimatedTokens += tokens;
      }
    }

    // Similar PRs (lower priority)
    if (similarPRs.length > 0) {
      const filtered = similarPRs.filter(
        (pr) => !bugfixes.some((bf) => bf.metadata.pr_number === pr.metadata.pr_number),
      );
      if (filtered.length > 0) {
        const section = formatSection("Similar Past PRs", filtered);
        const tokens = estimateTokens(section);
        if (estimatedTokens + tokens < maxTotalTokens) {
          sections.push(section);
          estimatedTokens += tokens;
        }
      }
    }

    if (sections.length === 0) {
      return "<rag_context>\nNo additional context found in the codebase.\n</rag_context>";
    }

    return `<rag_context>\n${sections.join("\n\n")}\n</rag_context>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatSection(title: string, results: RetrievalResult[]): string {
  const items = results
    .map((r) => {
      const source = r.source === "code"
        ? `[${r.metadata.file_path}:${r.metadata.start_line}-${r.metadata.end_line}]`
        : `[PR #${r.metadata.pr_number}]`;
      return `${source} (relevance: ${(r.score * 100).toFixed(0)}%)\n${r.content}`;
    })
    .join("\n---\n");

  return `### ${title}\n${items}`;
}

/**
 * Rough token estimation: 1 token ≈ 4 characters for code.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
