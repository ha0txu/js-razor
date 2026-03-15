#!/usr/bin/env node

/**
 * Code Review Agent — Entry Point
 *
 * Multi-agent code review system for JavaScript/TypeScript
 * React.js and Node.js projects.
 *
 * Usage:
 *   # Index the codebase (run once, then periodically)
 *   npx tsx src/index.ts index
 *
 *   # Index PR history (run once, then periodically)
 *   npx tsx src/index.ts index-prs --max 200
 *
 *   # Review a PR
 *   npx tsx src/index.ts review --pr 123
 *
 *   # Review and post comments to GitHub
 *   npx tsx src/index.ts review --pr 123 --post
 */

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { GitHubClient } from "./github/client.js";
import { CodebaseIndexer } from "./rag/indexer.js";
import type { ReviewOutput } from "./types/index.js";

const program = new Command();

program
  .name("code-review-agent")
  .description("Multi-agent code review for JS/TS React & Node.js projects")
  .version("1.0.0");

// ─── Index Codebase ──────────────────────────────────────────────────────────

program
  .command("index")
  .description("Index the codebase for RAG retrieval")
  .option("-p, --path <path>", "Path to the repository (default: current directory)")
  .action(async (opts) => {
    const config = loadConfig({ repo_path: opts.path });
    const indexer = new CodebaseIndexer(config);

    console.log("📦 Indexing codebase...\n");
    const result = await indexer.indexCodebase(opts.path);
    console.log(`\n✅ Indexed ${result.chunks} code chunks from ${result.files} files`);
  });

// ─── Index PR History ────────────────────────────────────────────────────────

program
  .command("index-prs")
  .description("Index merged PR history for bugfix reference")
  .option("-m, --max <number>", "Maximum PRs to index", "100")
  .action(async (opts) => {
    const config = loadConfig();
    const indexer = new CodebaseIndexer(config);

    console.log("📜 Indexing PR history...\n");
    const result = await indexer.indexPRHistory(parseInt(opts.max));
    console.log(`\n✅ Indexed ${result.indexed} PRs (${result.bugfixes} bugfixes)`);
  });

// ─── Review PR ───────────────────────────────────────────────────────────────

program
  .command("review")
  .description("Review a pull request")
  .requiredOption("--pr <number>", "PR number to review")
  .option("--post", "Post review comments to GitHub", false)
  .option("--json", "Output results as JSON", false)
  .option("-o, --output <path>", "Save results to a JSON file")
  .action(async (opts) => {
    const config = loadConfig();
    const github = new GitHubClient(config);
    const orchestrator = new Orchestrator(config);

    const prNumber = parseInt(opts.pr);
    console.log(`\n🔍 Fetching PR #${prNumber}...`);

    // Fetch PR data
    const prData = await github.fetchPR(prNumber);

    if (prData.files.length === 0) {
      console.log("   No reviewable JS/TS files in this PR. Skipping.");
      return;
    }

    // Run review
    const result = await orchestrator.review(prData);

    // Output results
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReviewResult(result);
    }

    // Save to file if requested
    if (opts.output) {
      const fs = await import("node:fs");
      fs.writeFileSync(opts.output, JSON.stringify(result, null, 2));
      console.log(`\n💾 Results saved to ${opts.output}`);
    }

    // Post to GitHub if requested
    if (opts.post && result.findings.length > 0) {
      console.log("\n📤 Posting review to GitHub...");
      const commitSha = await github.getLatestCommitSha(prNumber);
      const url = await github.postReview(
        prNumber,
        commitSha,
        result.findings,
        result.summary,
      );
      console.log(`   Review posted: ${url}`);
    }
  });

// ─── Pretty Print Results ────────────────────────────────────────────────────

function printReviewResult(result: ReviewOutput): void {
  const { findings, summary, stats, complexity } = result;

  console.log("\n" + "═".repeat(70));
  console.log(`  📋 REVIEW SUMMARY`);
  console.log("═".repeat(70));
  console.log(`\n  ${summary}\n`);
  console.log(`  Complexity: ${complexity.level} | Agents: ${stats.agents_run.join(", ")}`);
  console.log(`  Tokens: ${stats.total_tokens.toLocaleString()} | Time: ${(stats.total_duration_ms / 1000).toFixed(1)}s`);
  console.log(
    `  Findings: ${stats.total_findings} final (${stats.findings_before_verification} pre-verification)`,
  );

  if (findings.length === 0) {
    console.log("\n  ✅ No issues found!\n");
    return;
  }

  console.log("\n" + "─".repeat(70));

  const severityEmoji: Record<string, string> = {
    critical: "🔴",
    warning: "🟡",
    suggestion: "🔵",
    nitpick: "⚪",
  };

  for (const finding of findings) {
    const emoji = severityEmoji[finding.severity] ?? "⚪";
    console.log(
      `\n  ${emoji} [${finding.severity.toUpperCase()}] ${finding.title}`,
    );
    console.log(`     📁 ${finding.file}:${finding.line_start}-${finding.line_end}`);
    console.log(`     📂 Category: ${finding.category} | Confidence: ${(finding.confidence * 100).toFixed(0)}%`);
    console.log(`     ${finding.description}`);
    if (finding.suggestion) {
      console.log(`     💡 Fix: ${finding.suggestion}`);
    }
    if (finding.similar_pr_reference) {
      console.log(`     📎 Similar past bug: ${finding.similar_pr_reference}`);
    }
  }

  console.log("\n" + "═".repeat(70) + "\n");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parse();
