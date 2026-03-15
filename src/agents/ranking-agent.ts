import type { ReviewConfig, Finding, ReviewOutput, PRMetadata, ComplexityAssessment, Severity } from "../types/index.js";
import type { LLMClient } from "../providers/types.js";
import { createClient } from "../providers/index.js";
import { RANKING_AGENT_PROMPT } from "../prompts/system-prompts.js";

/**
 * Ranking Agent: Deduplicates, ranks, and summarizes verified findings.
 *
 * This is the final step before output. It:
 * 1. Removes duplicate findings (same issue from multiple agents)
 * 2. Ranks by severity and confidence
 * 3. Generates a human-friendly PR summary
 */
export class RankingAgent {
  private client: LLMClient;
  private config: ReviewConfig;
  private model: string;

  constructor(config: ReviewConfig) {
    this.config = config;
    this.model = config.model_simple_review;
    this.client = createClient(config, this.model);
  }

  async rankAndSummarize(
    findings: Finding[],
    prMetadata: PRMetadata,
    complexity: ComplexityAssessment,
    stats: {
      agents_run: string[];
      total_tokens: number;
      total_duration_ms: number;
      findings_before_verification: number;
    },
  ): Promise<ReviewOutput> {
    if (findings.length === 0) {
      return {
        pr: prMetadata,
        complexity,
        findings: [],
        summary: `✅ No issues found in PR #${prMetadata.number}. The changes look good.`,
        stats: {
          total_findings: 0,
          by_severity: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
          by_category: {},
          ...stats,
          findings_after_verification: 0,
        },
      };
    }

    // For small finding sets, do local dedup + ranking (no LLM call needed)
    if (findings.length <= 5) {
      return this.localRankAndSummarize(findings, prMetadata, complexity, stats);
    }

    // For larger sets, use Claude for intelligent dedup and summary
    try {
      const prompt = [
        `PR #${prMetadata.number}: "${prMetadata.title}" by ${prMetadata.author}`,
        `Files changed: ${findings.map((f) => f.file).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`,
        "",
        `${findings.length} verified findings to rank and deduplicate:`,
        "",
        JSON.stringify(findings, null, 2),
      ].join("\n");

      const response = await this.client.chat({
        model: this.model,
        max_tokens: 4096,
        system: RANKING_AGENT_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });

      const text = response.text_content;

      const result = this.parseRankingResult(text, findings);

      return {
        pr: prMetadata,
        complexity,
        findings: result.findings,
        summary: result.summary,
        stats: {
          total_findings: result.findings.length,
          by_severity: countBySeverity(result.findings),
          by_category: countByCategory(result.findings),
          ...stats,
          findings_after_verification: result.findings.length,
        },
      };
    } catch {
      // Fallback to local ranking
      return this.localRankAndSummarize(findings, prMetadata, complexity, stats);
    }
  }

  /**
   * Local dedup + ranking for small finding sets (no LLM call).
   */
  private localRankAndSummarize(
    findings: Finding[],
    prMetadata: PRMetadata,
    complexity: ComplexityAssessment,
    stats: {
      agents_run: string[];
      total_tokens: number;
      total_duration_ms: number;
      findings_before_verification: number;
    },
  ): ReviewOutput {
    // Simple dedup by file+line+title similarity
    const deduped = deduplicateFindings(findings);

    // Sort by severity then confidence
    const severityOrder: Record<string, number> = {
      critical: 0,
      warning: 1,
      suggestion: 2,
      nitpick: 3,
    };
    deduped.sort((a, b) => {
      const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      return b.confidence - a.confidence;
    });

    // Generate summary
    const criticals = deduped.filter((f) => f.severity === "critical");
    const warnings = deduped.filter((f) => f.severity === "warning");

    let summary: string;
    if (criticals.length > 0) {
      summary =
        `⚠️ Found ${criticals.length} critical issue(s) in PR #${prMetadata.number}. ` +
        `${criticals[0].title}. Please address before merging.`;
    } else if (warnings.length > 0) {
      summary =
        `Found ${deduped.length} issue(s) in PR #${prMetadata.number} ` +
        `(${warnings.length} warning(s)). No critical issues.`;
    } else {
      summary =
        `Minor suggestions for PR #${prMetadata.number}. ` +
        `${deduped.length} suggestion(s) found — nothing blocking.`;
    }

    const prReferences = deduped.filter((f) => f.similar_pr_reference);
    if (prReferences.length > 0) {
      summary += ` Note: ${prReferences.length} finding(s) match patterns from past bugfixes.`;
    }

    return {
      pr: prMetadata,
      complexity,
      findings: deduped,
      summary,
      stats: {
        total_findings: deduped.length,
        by_severity: countBySeverity(deduped),
        by_category: countByCategory(deduped),
        ...stats,
        findings_after_verification: deduped.length,
      },
    };
  }

  private parseRankingResult(
    text: string,
    originalFindings: Finding[],
  ): { findings: Finding[]; summary: string } {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { findings: originalFindings, summary: "Review complete." };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        findings: parsed.findings ?? originalFindings,
        summary: parsed.summary ?? "Review complete.",
      };
    } catch {
      return { findings: originalFindings, summary: "Review complete." };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();

  for (const finding of findings) {
    // Dedup key: file + approximate line range + category
    const key = `${finding.file}:${Math.floor(finding.line_start / 3)}:${finding.category}`;

    const existing = seen.get(key);
    if (!existing || finding.confidence > existing.confidence) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

function countByCategory(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  }
  return counts;
}
