import pLimit from "p-limit";
import type {
  ReviewConfig,
  PRData,
  ComplexityAssessment,
  AgentType,
  Finding,
  AgentResult,
  ReviewOutput,
} from "./types/index.js";
import { BaseReviewAgent } from "./agents/base-agent.js";
import {
  createLogicAgent,
  createSecurityAgent,
  createPerformanceAgent,
  createReactPatternsAgent,
  createEdgeCasesAgent,
  createSimpleReviewAgent,
} from "./agents/review-agents.js";
import { VerificationAgent } from "./agents/verification-agent.js";
import { RankingAgent } from "./agents/ranking-agent.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Orchestrator: The central coordinator for the code review pipeline.
 *
 * Flow:
 * 1. Assess PR complexity → determine which agents to dispatch
 * 2. Load project context (CLAUDE.md, REVIEW.md)
 * 3. Dispatch specialized agents in parallel
 * 4. Collect findings → cross-verify with verification agent
 * 5. Rank, deduplicate, and format final output
 *
 * Adaptive scaling:
 * - Trivial PRs → single lightweight pass (Haiku)
 * - Standard PRs → 3-5 specialized agents in parallel (Sonnet)
 * - Complex PRs → all agents + enhanced verification (Sonnet/Opus)
 */
export class Orchestrator {
  private config: ReviewConfig;
  private verificationAgent: VerificationAgent;
  private rankingAgent: RankingAgent;

  constructor(config: ReviewConfig) {
    this.config = config;
    this.verificationAgent = new VerificationAgent(config);
    this.rankingAgent = new RankingAgent(config);
  }

  /**
   * Run a complete code review on a PR.
   */
  async review(prData: PRData): Promise<ReviewOutput> {
    const startTime = Date.now();
    console.log(`\n🔍 Starting review of PR #${prData.metadata.number}: "${prData.metadata.title}"`);
    console.log(`   ${prData.total_files_changed} files, +${prData.total_additions}/-${prData.total_deletions}`);

    // Step 1: Assess complexity
    const complexity = this.assessComplexity(prData);
    console.log(`   Complexity: ${complexity.level} → dispatching: ${complexity.agents_to_dispatch.join(", ")}`);

    // Step 2: Load project context
    const projectContext = this.loadProjectContext();
    const reviewRules = this.loadReviewRules();

    // Step 3: Dispatch agents
    const headRef = prData.metadata.head_branch;
    let allFindings: Finding[] = [];
    let totalTokens = 0;
    const agentsRun: string[] = [];

    if (complexity.level === "trivial") {
      // Single lightweight pass
      console.log(`   Running simple review...`);
      const agent = createSimpleReviewAgent(this.config);
      const result = await agent.review(prData.files, projectContext, reviewRules, headRef);
      allFindings = result.findings;
      totalTokens += result.tokens_used;
      agentsRun.push(result.agent_name);
      if (result.error) console.warn(`   ⚠️ ${result.error}`);
    } else {
      // Parallel specialized review
      const agents = this.createAgents(complexity.agents_to_dispatch);
      console.log(`   Running ${agents.length} agents in parallel...`);

      // Limit concurrency to avoid rate limits
      const limit = pLimit(3);

      const results = await Promise.all(
        agents.map((agent) =>
          limit(async () => {
            console.log(`   → [${agent.name}] started`);
            const result = await agent.review(prData.files, projectContext, reviewRules, headRef);
            console.log(
              `   ✓ [${result.agent_name}] done: ${result.findings.length} findings, ` +
              `${result.tokens_used} tokens, ${(result.duration_ms / 1000).toFixed(1)}s`,
            );
            if (result.error) console.warn(`   ⚠️ [${result.agent_name}] ${result.error}`);
            return result;
          }),
        ),
      );

      for (const result of results) {
        allFindings.push(...result.findings);
        totalTokens += result.tokens_used;
        agentsRun.push(result.agent_name);
      }
    }

    const findingsBeforeVerification = allFindings.length;
    console.log(`\n   📊 Total findings before verification: ${findingsBeforeVerification}`);

    // Step 4: Safety check — escalate if too many findings
    if (allFindings.length > this.config.max_findings_before_escalation) {
      console.warn(
        `   ⚠️ ${allFindings.length} findings exceed threshold (${this.config.max_findings_before_escalation}). ` +
        `This may indicate a misconfigured review. Consider manual review.`,
      );
      // Still proceed, but flag in output
    }

    // Step 5: Cross-verification (skip for trivial PRs or no findings)
    if (complexity.level !== "trivial" && allFindings.length > 0) {
      console.log(`\n   🔎 Running verification agent on ${allFindings.length} findings...`);
      const verificationResult = await this.verificationAgent.verify(
        allFindings,
        prData.files,
        headRef,
      );
      allFindings = verificationResult.findings;
      totalTokens += verificationResult.tokens_used;
      agentsRun.push("verification");

      if (verificationResult.error) {
        console.warn(`   ⚠️ ${verificationResult.error}`);
      }
    }

    // Step 6: Rank and summarize
    console.log(`\n   📝 Ranking ${allFindings.length} verified findings...`);
    const totalDuration = Date.now() - startTime;

    const output = await this.rankingAgent.rankAndSummarize(
      allFindings,
      prData.metadata,
      complexity,
      {
        agents_run: agentsRun,
        total_tokens: totalTokens,
        total_duration_ms: totalDuration,
        findings_before_verification: findingsBeforeVerification,
      },
    );

    // Step 7: Report
    console.log(`\n✅ Review complete:`);
    console.log(`   ${output.findings.length} findings (${findingsBeforeVerification} pre-verification)`);
    console.log(`   ${totalTokens} total tokens, ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`   Summary: ${output.summary}`);

    return output;
  }

  // ─── Complexity Assessment ─────────────────────────────────────────────

  private assessComplexity(prData: PRData): ComplexityAssessment {
    const { files, total_additions, total_deletions, metadata } = prData;
    const totalChanges = total_additions + total_deletions;
    const reasons: string[] = [];
    const agents: Set<AgentType> = new Set();

    // Start with all agents
    const allAgents: AgentType[] = ["logic", "security", "performance", "react-patterns", "edge-cases"];

    // ─── Trivial ───
    if (
      totalChanges < 20 &&
      files.length <= 2 &&
      files.every((f) => f.status === "modified")
    ) {
      return {
        level: "trivial",
        reasons: ["Very small PR with few changes"],
        agents_to_dispatch: [],
        model_tier: "haiku",
      };
    }

    // ─── Critical ───
    const hasSecurityLabels = metadata.labels.some((l) =>
      /security|auth|secret|token|credential/i.test(l),
    );
    const touchesAuth = files.some((f) =>
      /auth|login|session|token|password|secret|credential|middleware/i.test(f.filename),
    );
    const touchesPayment = files.some((f) =>
      /payment|billing|stripe|checkout|subscription/i.test(f.filename),
    );

    if (hasSecurityLabels || touchesAuth || touchesPayment) {
      reasons.push("Security-sensitive changes detected");
      agents.add("security");
      agents.add("logic");
      agents.add("edge-cases");

      if (totalChanges > 200) {
        return {
          level: "critical",
          reasons,
          agents_to_dispatch: allAgents,
          model_tier: "opus",
        };
      }
    }

    // ─── Detect React-specific content ───
    const hasReactFiles = files.some((f) => /\.(tsx|jsx)$/.test(f.filename));
    const hasHooks = files.some((f) =>
      f.patch.includes("useState") ||
      f.patch.includes("useEffect") ||
      f.patch.includes("useCallback") ||
      f.patch.includes("useMemo"),
    );

    if (hasReactFiles || hasHooks) {
      reasons.push("React components/hooks modified");
      agents.add("react-patterns");
    }

    // ─── Detect Node.js/API changes ───
    const hasRoutes = files.some((f) =>
      /route|controller|handler|middleware|api/i.test(f.filename),
    );
    const hasDbChanges = files.some((f) =>
      /model|schema|migration|repository|dao/i.test(f.filename),
    );

    if (hasRoutes || hasDbChanges) {
      reasons.push("API/database changes detected");
      agents.add("security");
      agents.add("performance");
      agents.add("edge-cases");
    }

    // ─── Size-based escalation ───
    if (totalChanges > 500) {
      reasons.push(`Large PR (${totalChanges} lines changed)`);
      agents.add("logic");
      agents.add("performance");
    }

    if (files.length > 10) {
      reasons.push(`Many files changed (${files.length})`);
      agents.add("logic");
      agents.add("architecture" as AgentType);  // covered by logic agent
    }

    // ─── Standard: always include logic ───
    agents.add("logic");

    // Determine level
    const level: ComplexityAssessment["level"] =
      totalChanges > 500 || files.length > 15
        ? "complex"
        : "standard";

    return {
      level,
      reasons: reasons.length > 0 ? reasons : ["Standard PR"],
      agents_to_dispatch: Array.from(agents).filter((a) => allAgents.includes(a)),
      model_tier: level === "complex" ? "sonnet" : "sonnet",
    };
  }

  // ─── Agent Factory ─────────────────────────────────────────────────────

  private createAgents(types: AgentType[]): BaseReviewAgent[] {
    const factory: Record<AgentType, () => BaseReviewAgent> = {
      "logic": () => createLogicAgent(this.config),
      "security": () => createSecurityAgent(this.config),
      "performance": () => createPerformanceAgent(this.config),
      "react-patterns": () => createReactPatternsAgent(this.config),
      "edge-cases": () => createEdgeCasesAgent(this.config),
    };

    return types
      .filter((t) => factory[t])
      .map((t) => factory[t]());
  }

  // ─── Project Context Loading ───────────────────────────────────────────

  private loadProjectContext(): string {
    const candidates = ["CLAUDE.md", "PROJECT.md", ".github/CONTEXT.md"];
    for (const filename of candidates) {
      const filePath = path.join(this.config.repo_path, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        // Truncate to keep context manageable
        return content.slice(0, 3000);
      }
    }
    return "No project context file found. Review based on code conventions only.";
  }

  private loadReviewRules(): string {
    const candidates = ["REVIEW.md", ".github/REVIEW.md", ".github/review-rules.md"];
    for (const filename of candidates) {
      const filePath = path.join(this.config.repo_path, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        return content.slice(0, 2000);
      }
    }
    return DEFAULT_REVIEW_RULES;
  }
}

const DEFAULT_REVIEW_RULES = `
# Review Rules (Default)

## Priorities (in order)
1. Security vulnerabilities (always flag)
2. Logic errors that cause bugs
3. Missing error handling on critical paths
4. Performance issues on hot paths
5. React anti-patterns that cause re-render storms

## Do NOT flag
- Style/formatting issues (handled by linters)
- Minor naming disagreements
- TODO comments (tracked separately)
- Test coverage gaps (unless critical paths)

## Tone
- Be constructive and specific
- Explain WHY something is a problem, not just WHAT
- Provide a concrete fix suggestion when possible
- Reference past bugs when relevant
`;
