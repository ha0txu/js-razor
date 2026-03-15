import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import ignore from "ignore";
import { Octokit } from "@octokit/rest";
import { EmbeddingService } from "./embeddings.js";
import { LocalVectorStore } from "./vector-store.js";
import { parseFile } from "./code-parser.js";
import type { ReviewConfig, CodeChunk, PRHistoryEntry } from "../types/index.js";

/**
 * Indexes a JavaScript/TypeScript codebase and its PR history into
 * the vector store for RAG retrieval during code review.
 *
 * Two namespaces:
 *   - "code" — semantic code chunks (functions, components, hooks, etc.)
 *   - "pr-history" — past PRs with diffs, review comments, and bugfix metadata
 */
export class CodebaseIndexer {
  private embeddings: EmbeddingService;
  private codeStore: LocalVectorStore;
  private prStore: LocalVectorStore;
  private config: ReviewConfig;

  constructor(config: ReviewConfig) {
    this.config = config;
    this.embeddings = new EmbeddingService(config);
    this.codeStore = new LocalVectorStore(config.vector_store_path, "code");
    this.prStore = new LocalVectorStore(config.vector_store_path, "pr-history");
  }

  // ─── Code Indexing ───────────────────────────────────────────────────────

  /**
   * Index all JS/TS files in the repository.
   * Respects .gitignore patterns.
   */
  async indexCodebase(repoPath?: string): Promise<{ chunks: number; files: number }> {
    const basePath = repoPath ?? this.config.repo_path;

    // Load .gitignore patterns
    const ig = ignore();
    const gitignorePath = path.join(basePath, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, "utf-8"));
    }
    // Always ignore these
    ig.add(["node_modules", "dist", "build", ".next", "coverage", ".git", "*.min.js", "*.bundle.js"]);

    // Find all JS/TS files
    const files = await glob("**/*.{ts,tsx,js,jsx,mjs}", {
      cwd: basePath,
      nodir: true,
      absolute: false,
    });

    const relevantFiles = files.filter((f) => !ig.ignores(f));
    console.log(`Found ${relevantFiles.length} JS/TS files to index`);

    // Parse files into chunks
    const allChunks: CodeChunk[] = [];
    for (const file of relevantFiles) {
      try {
        const fullPath = path.join(basePath, file);
        const content = fs.readFileSync(fullPath, "utf-8");
        const chunks = parseFile(file, content);
        allChunks.push(...chunks);
      } catch (err) {
        console.warn(`  Skipping ${file}: ${(err as Error).message}`);
      }
    }

    console.log(`Parsed ${allChunks.length} code chunks from ${relevantFiles.length} files`);

    // Generate embeddings in batches
    const textsToEmbed = allChunks.map((chunk) => buildCodeEmbeddingText(chunk));
    const vectors = await this.embeddings.embedBatch(textsToEmbed);

    // Upsert into vector store
    const items = allChunks.map((chunk, i) => ({
      id: chunk.id,
      vector: vectors[i],
      metadata: {
        file_path: chunk.file_path,
        type: chunk.type,
        name: chunk.name,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        exports: chunk.exports,
      },
      text: chunk.content,
    }));

    this.codeStore.clear();
    this.codeStore.upsert(items);

    console.log(`Indexed ${items.length} code chunks into vector store`);
    return { chunks: items.length, files: relevantFiles.length };
  }

  // ─── PR History Indexing ─────────────────────────────────────────────────

  /**
   * Index closed/merged PRs from GitHub.
   * Prioritizes bugfix PRs (labeled 'bug', 'bugfix', 'fix' or with 'fix' in title).
   *
   * @param maxPRs - Maximum number of PRs to index (default: 100)
   */
  async indexPRHistory(maxPRs = 100): Promise<{ indexed: number; bugfixes: number }> {
    const octokit = new Octokit({ auth: this.config.github_token });
    const { github_owner: owner, github_repo: repo } = this.config;

    console.log(`Fetching up to ${maxPRs} merged PRs from ${owner}/${repo}...`);

    // Fetch merged PRs, newest first
    const prs: PRHistoryEntry[] = [];
    let page = 1;

    while (prs.length < maxPRs) {
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: Math.min(100, maxPRs - prs.length),
        page,
      });

      if (data.length === 0) break;

      for (const pr of data) {
        if (!pr.merged_at) continue; // Skip unmerged

        // Fetch PR files (condensed diff)
        const { data: files } = await octokit.pulls.listFiles({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });

        // Only index PRs that touch JS/TS files
        const jsFiles = files.filter((f) =>
          /\.(ts|tsx|js|jsx|mjs)$/.test(f.filename),
        );
        if (jsFiles.length === 0) continue;

        // Fetch review comments
        const { data: comments } = await octokit.pulls.listReviewComments({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 50,
        });

        const labels = pr.labels.map((l) => l.name ?? "");
        const isBugfix = detectBugfix(pr.title, pr.body ?? "", labels);

        // Build condensed diff summary (keeps token count manageable)
        const diffSummary = jsFiles
          .map((f) => {
            const patchPreview = f.patch
              ? f.patch.slice(0, 500) + (f.patch.length > 500 ? "\n..." : "")
              : "[no diff]";
            return `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${patchPreview}`;
          })
          .join("\n\n");

        const reviewComments = comments
          .map((c) => `[${c.path}:${c.line ?? "?"}] ${c.body}`)
          .join("\n");

        prs.push({
          id: `pr-${pr.number}`,
          pr_number: pr.number,
          title: pr.title,
          description: pr.body ?? "",
          author: pr.user?.login ?? "unknown",
          merged_at: pr.merged_at,
          labels,
          files_changed: jsFiles.map((f) => f.filename),
          diff_summary: diffSummary,
          review_comments: reviewComments,
          is_bugfix: isBugfix,
          bug_description: isBugfix
            ? extractBugDescription(pr.title, pr.body ?? "")
            : undefined,
          fix_description: isBugfix
            ? extractFixDescription(pr.title, pr.body ?? "", diffSummary)
            : undefined,
        });
      }

      page++;
    }

    console.log(`Fetched ${prs.length} relevant PRs (${prs.filter((p) => p.is_bugfix).length} bugfixes)`);

    // Generate embeddings
    const textsToEmbed = prs.map((pr) => buildPREmbeddingText(pr));
    const vectors = await this.embeddings.embedBatch(textsToEmbed);

    const items = prs.map((pr, i) => ({
      id: pr.id,
      vector: vectors[i],
      metadata: {
        pr_number: pr.pr_number,
        title: pr.title,
        is_bugfix: pr.is_bugfix,
        labels: pr.labels,
        files_changed: pr.files_changed,
        merged_at: pr.merged_at,
      },
      text: buildPRContextText(pr),
    }));

    this.prStore.clear();
    this.prStore.upsert(items);

    console.log(`Indexed ${items.length} PRs into vector store`);
    return {
      indexed: items.length,
      bugfixes: prs.filter((p) => p.is_bugfix).length,
    };
  }

  get codeStoreSize(): number {
    return this.codeStore.size;
  }

  get prStoreSize(): number {
    return this.prStore.size;
  }
}

// ─── Embedding Text Builders ───────────────────────────────────────────────

/**
 * Build the text to embed for a code chunk.
 * Combines structural metadata with code content for better semantic matching.
 */
function buildCodeEmbeddingText(chunk: CodeChunk): string {
  const parts = [
    `[${chunk.type}] ${chunk.name}`,
    `File: ${chunk.file_path}`,
  ];
  if (chunk.exports.length > 0) {
    parts.push(`Exports: ${chunk.exports.join(", ")}`);
  }
  parts.push(chunk.content);
  return parts.join("\n");
}

/**
 * Build the text to embed for a PR.
 * Emphasis on bug descriptions and fix patterns for bugfix PRs.
 */
function buildPREmbeddingText(pr: PRHistoryEntry): string {
  const parts = [
    `PR #${pr.pr_number}: ${pr.title}`,
    pr.is_bugfix ? "[BUGFIX]" : "",
    pr.description.slice(0, 500),
    `Files: ${pr.files_changed.join(", ")}`,
    pr.bug_description ? `Bug: ${pr.bug_description}` : "",
    pr.fix_description ? `Fix: ${pr.fix_description}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Build the full context text stored alongside the PR vector.
 * This is what gets returned to the review agents as context.
 */
function buildPRContextText(pr: PRHistoryEntry): string {
  const parts = [
    `=== PR #${pr.pr_number}: ${pr.title} ===`,
    pr.is_bugfix ? `[BUGFIX] ${pr.bug_description ?? ""}` : "",
    `Author: ${pr.author} | Merged: ${pr.merged_at}`,
    `Labels: ${pr.labels.join(", ") || "none"}`,
    `Files changed: ${pr.files_changed.join(", ")}`,
    "",
    "--- Diff Summary ---",
    pr.diff_summary.slice(0, 2000),
  ];

  if (pr.review_comments) {
    parts.push("", "--- Review Comments ---", pr.review_comments.slice(0, 1000));
  }
  if (pr.fix_description) {
    parts.push("", "--- Fix Pattern ---", pr.fix_description);
  }

  return parts.filter((p) => p !== undefined).join("\n");
}

// ─── PR Classification Helpers ─────────────────────────────────────────────

const BUGFIX_LABEL_PATTERNS = /^(bug|bugfix|fix|hotfix|patch|regression)$/i;
const BUGFIX_TITLE_PATTERNS = /\b(fix|bug|patch|hotfix|resolve|repair|correct)\b/i;

function detectBugfix(title: string, body: string, labels: string[]): boolean {
  if (labels.some((l) => BUGFIX_LABEL_PATTERNS.test(l))) return true;
  if (BUGFIX_TITLE_PATTERNS.test(title)) return true;
  // Check for conventional commit prefixes
  if (/^fix(\(.+\))?:/.test(title)) return true;
  return false;
}

function extractBugDescription(title: string, body: string): string {
  // Try to find a "Bug:" or "Problem:" section in the body
  const bugMatch = body.match(/(?:bug|problem|issue|root cause)[:\s]+(.+?)(?:\n\n|\n#|$)/is);
  if (bugMatch) return bugMatch[1].trim().slice(0, 300);
  return title;
}

function extractFixDescription(title: string, body: string, diff: string): string {
  const fixMatch = body.match(/(?:fix|solution|resolution|changes?)[:\s]+(.+?)(?:\n\n|\n#|$)/is);
  if (fixMatch) return fixMatch[1].trim().slice(0, 500);
  // Fall back to title + first part of diff
  return `${title}\n${diff.slice(0, 300)}`;
}
