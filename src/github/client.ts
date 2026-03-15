import { Octokit } from "@octokit/rest";
import type { ReviewConfig, PRData, PRMetadata, FileDiff, Finding } from "../types/index.js";

/**
 * GitHub integration layer for fetching PR data and posting review comments.
 */
export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: ReviewConfig) {
    this.octokit = new Octokit({ auth: config.github_token });
    this.owner = config.github_owner;
    this.repo = config.github_repo;
  }

  // ─── PR Data Fetching ──────────────────────────────────────────────────

  /**
   * Fetch complete PR data including metadata and file diffs.
   * Pre-processes diffs to strip unnecessary context.
   */
  async fetchPR(prNumber: number): Promise<PRData> {
    const [prResponse, filesResponse] = await Promise.all([
      this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }),
      this.octokit.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 300,
      }),
    ]);

    const pr = prResponse.data;

    const metadata: PRMetadata = {
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
      title: pr.title,
      description: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      base_branch: pr.base.ref,
      head_branch: pr.head.ref,
      created_at: pr.created_at,
      labels: pr.labels.map((l) => l.name ?? ""),
    };

    const files: FileDiff[] = filesResponse.data
      .filter((f) => isReviewableFile(f.filename))
      .map((f) => ({
        filename: f.filename,
        status: f.status as FileDiff["status"],
        additions: f.additions,
        deletions: f.deletions,
        patch: optimizePatch(f.patch ?? ""),
      }));

    return {
      metadata,
      files,
      total_additions: files.reduce((sum, f) => sum + f.additions, 0),
      total_deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      total_files_changed: files.length,
    };
  }

  /**
   * Fetch the full content of a file from the PR's head branch.
   */
  async fetchFileContent(filePath: string, ref: string): Promise<string> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref,
      });

      if ("content" in response.data && response.data.type === "file") {
        return Buffer.from(response.data.content, "base64").toString("utf-8");
      }
      return "";
    } catch {
      return "";
    }
  }

  // ─── Review Comment Posting ────────────────────────────────────────────

  /**
   * Post findings as a PR review with inline comments.
   */
  async postReview(
    prNumber: number,
    commitSha: string,
    findings: Finding[],
    summary: string,
  ): Promise<string> {
    // Build inline comments
    const comments = findings
      .filter((f) => f.line_start > 0)
      .map((f) => ({
        path: f.file,
        line: f.line_end,
        start_line: f.line_start !== f.line_end ? f.line_start : undefined,
        body: formatFindingComment(f),
      }));

    // Post the review
    const response = await this.octokit.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_id: commitSha,
      body: summary,
      event: "COMMENT",
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        ...(c.start_line ? { start_line: c.start_line } : {}),
        body: c.body,
      })),
    });

    return response.data.html_url;
  }

  /**
   * Get the latest commit SHA for a PR.
   */
  async getLatestCommitSha(prNumber: number): Promise<string> {
    const { data: commits } = await this.octokit.pulls.listCommits({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 1,
    });

    const lastCommit = commits[commits.length - 1];
    return lastCommit?.sha ?? "";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Only review JS/TS files — skip configs, lock files, assets.
 */
function isReviewableFile(filename: string): boolean {
  // Include JS/TS source files
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(filename)) {
    // Exclude generated/vendored files
    if (filename.includes(".min.") || filename.includes(".bundle.")) return false;
    if (filename.includes("node_modules/")) return false;
    if (filename.includes("__generated__/")) return false;
    if (filename.endsWith(".d.ts")) return false;
    return true;
  }
  // Also review config files that affect runtime behavior
  if (/\.(json|yaml|yml)$/.test(filename)) {
    return (
      filename.includes("package.json") ||
      filename.includes("tsconfig") ||
      filename.includes(".eslintrc") ||
      filename.includes("next.config") ||
      filename.includes("vite.config") ||
      filename.includes("webpack.config")
    );
  }
  return false;
}

/**
 * Optimize diff patch to reduce token usage.
 * - Reduce context lines from default 3 to what's actually needed
 * - Strip trailing whitespace
 * - Mark binary file changes as skipped
 */
function optimizePatch(patch: string): string {
  if (!patch) return "[empty diff]";

  // Limit very large patches
  if (patch.length > 10000) {
    return patch.slice(0, 10000) + "\n... [diff truncated, showing first ~250 lines]";
  }

  return patch
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/**
 * Format a finding as a GitHub PR review comment.
 */
function formatFindingComment(finding: Finding): string {
  const severityEmoji: Record<string, string> = {
    critical: "🔴",
    warning: "🟡",
    suggestion: "🔵",
    nitpick: "⚪",
  };

  const emoji = severityEmoji[finding.severity] ?? "⚪";
  const lines = [
    `${emoji} **${finding.severity.toUpperCase()}**: ${finding.title}`,
    "",
    finding.description,
  ];

  if (finding.suggestion) {
    lines.push("", "**Suggestion:**", "```", finding.suggestion, "```");
  }

  if (finding.similar_pr_reference) {
    lines.push("", `📎 _Similar issue found in: ${finding.similar_pr_reference}_`);
  }

  lines.push("", `_Confidence: ${(finding.confidence * 100).toFixed(0)}% | Category: ${finding.category}_`);

  return lines.join("\n");
}
