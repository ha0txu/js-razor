import { BaseReviewAgent } from "./base-agent.js";
import {
  LOGIC_AGENT_PROMPT,
  SECURITY_AGENT_PROMPT,
  PERFORMANCE_AGENT_PROMPT,
  REACT_PATTERNS_AGENT_PROMPT,
  EDGE_CASES_AGENT_PROMPT,
  SIMPLE_REVIEW_PROMPT,
} from "../prompts/system-prompts.js";
import type { ReviewConfig } from "../types/index.js";

/**
 * Factory for creating specialized review agents.
 * Each agent uses the same base agentic loop but with different
 * system prompts focused on its area of expertise.
 */

export function createLogicAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "logic",
    LOGIC_AGENT_PROMPT,
    "logical errors, null references, async bugs, type coercion issues in JavaScript/TypeScript",
    config,
  );
}

export function createSecurityAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "security",
    SECURITY_AGENT_PROMPT,
    "security vulnerabilities: injection, XSS, auth bypass, data exposure in React and Node.js",
    config,
  );
}

export function createPerformanceAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "performance",
    PERFORMANCE_AGENT_PROMPT,
    "performance issues: React re-renders, N+1 queries, memory leaks, bundle size in JS/TS",
    config,
  );
}

export function createReactPatternsAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "react-patterns",
    REACT_PATTERNS_AGENT_PROMPT,
    "React anti-patterns: hook violations, state management issues, component design, Next.js SSR",
    config,
  );
}

export function createEdgeCasesAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "edge-cases",
    EDGE_CASES_AGENT_PROMPT,
    "missing error handling, input validation gaps, boundary conditions, resource cleanup",
    config,
  );
}

export function createSimpleReviewAgent(config: ReviewConfig): BaseReviewAgent {
  return new BaseReviewAgent(
    "simple-review",
    SIMPLE_REVIEW_PROMPT,
    "general review of a small PR for logic, security, and React patterns",
    config,
    { model: config.model_simple_review, maxIterations: 3 },
  );
}
