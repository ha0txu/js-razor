# Code Review Agent

Multi-agent AI code review system for **JavaScript/TypeScript** projects using **React.js** and **Node.js**. Five specialized agents review your PRs in parallel, a verification agent filters false positives, and findings are posted as inline GitHub comments.

Supports both **Claude** (Anthropic) and **Gemini** (Google) models — mix and match freely.

## How It Works

```
   PR Opened
       │
       ▼
  ┌──────────┐
  │Orchestrator│──── Assesses complexity, loads REVIEW.md rules
  └─────┬──────┘
        │ dispatches in parallel
  ┌─────┼─────┬──────────┬──────────┐
  ▼     ▼     ▼          ▼          ▼
Logic Security Perf   React    Edge Cases
Agent  Agent   Agent  Patterns   Agent
  │     │       │      Agent       │
  └─────┴───┬───┴────────┴────────┘
            ▼
    Verification Agent  ← re-reads code, disproves false positives
            │
            ▼
     Ranking Agent  ← deduplicates, sorts by severity
            │
            ▼
    PR Review Comments
```

Each agent uses **RAG** (Retrieval-Augmented Generation) to pull relevant context from your codebase and past PR history — including previous bugfixes — so the review catches patterns your team has already burned by.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your API keys

# 3. Index your codebase (one-time, then periodically)
npm run index -- --path /path/to/your/repo

# 4. Index past PRs so the agent learns from your bugfix history
npm run index-prs -- --max 200

# 5. Review a PR
npm run review -- --pr 123

# 6. Review and post comments to GitHub
npm run review -- --pr 123 --post
```

## Configuration

### API Keys

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | If using `claude-*` models | Claude API access |
| `GEMINI_API_KEY` | If using `gemini-*` models | Gemini API access |
| `OPENAI_API_KEY` | Yes | Embedding generation for RAG |
| `GITHUB_TOKEN` | Yes | PR access and comment posting |

### Model Selection

The provider is auto-detected from the model name prefix. Set these in `.env`:

```bash
# All Claude (default)
MODEL_REVIEW_AGENT=claude-sonnet-4-20250514
MODEL_SIMPLE_REVIEW=claude-haiku-4-5-20251001

# All Gemini
MODEL_REVIEW_AGENT=gemini-2.5-pro
MODEL_SIMPLE_REVIEW=gemini-2.5-flash

# Mixed: Gemini reviews + Claude verification
MODEL_REVIEW_AGENT=gemini-2.5-pro
MODEL_VERIFICATION=claude-sonnet-4-20250514
MODEL_SIMPLE_REVIEW=gemini-2.5-flash
```

Only the API keys for providers you actually use are required.

### Review Rules

Create a `REVIEW.md` in your repo root to define your team's review priorities:

```markdown
## Review Priorities
1. Security vulnerabilities
2. Logic errors
3. Missing error handling

## Do NOT Flag
- Formatting issues (handled by ESLint/Prettier)
- TODO comments

## Architecture Rules
- API routes must validate input with Zod
- Database queries must use parameterized statements
```

Create a `CLAUDE.md` in your repo root to describe your project architecture (tech stack, directory structure, key patterns) so the agent understands your codebase conventions.

## Specialized Agents

| Agent | Focus | JS/TS-Specific Checks |
|---|---|---|
| **Logic** | Correctness bugs | Null/undefined, async/await, type coercion, closures |
| **Security** | Vulnerabilities | XSS via dangerouslySetInnerHTML, injection, auth bypass, secret leakage |
| **Performance** | Runtime efficiency | React re-renders, N+1 queries, memory leaks, bundle size |
| **React Patterns** | Framework misuse | Hook violations, stale closures, SSR issues, key props |
| **Edge Cases** | Missing handling | Error boundaries, input validation, resource cleanup, timeouts |

For trivial PRs (< 20 lines, 1-2 files), a single lightweight agent runs instead of the full suite.

## RAG System

The review agent builds two vector indexes:

**Code Index** — Parses your JS/TS files into semantic chunks (functions, components, hooks, routes, classes) and embeds them. During review, agents retrieve related code (callers, dependents, similar patterns) to understand context beyond the diff.

**PR History Index** — Indexes your merged PRs from GitHub, identifying bugfix PRs by labels and conventional commit prefixes. During review, agents search for past bugs in similar code, and reference them in findings:

> 📎 *Similar issue found in: PR #142 — "fix: race condition in useAuth hook"*

Run `npm run index-prs` periodically (or set up the weekly GitHub Action) to keep the history fresh.

## GitHub Actions Integration

### Basic Setup

Add these secrets to your repo (Settings → Secrets → Actions):
- `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY`
- `OPENAI_API_KEY`

Copy `.github/workflows/code-review.yml` to your repo. PRs will be reviewed automatically.

### As a Reusable Action

```yaml
# .github/workflows/code-review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
    paths: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: your-org/code-review-agent@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

See [GITHUB_ACTIONS_GUIDE.md](./GITHUB_ACTIONS_GUIDE.md) for the full integration guide including caching, Slack notifications, and branch protection setup.

## Project Structure

```
src/
├── providers/          # LLM provider abstraction (Claude + Gemini)
│   ├── types.ts        # Unified LLMClient interface
│   ├── anthropic-client.ts
│   ├── gemini-client.ts
│   └── index.ts        # Auto-detection factory
├── agents/
│   ├── base-agent.ts   # Provider-agnostic agentic loop
│   ├── review-agents.ts # 5 specialized agent factories
│   ├── verification-agent.ts
│   └── ranking-agent.ts
├── rag/
│   ├── code-parser.ts  # JS/TS semantic chunking
│   ├── embeddings.ts   # OpenAI embedding service
│   ├── vector-store.ts # Local cosine-similarity store
│   ├── indexer.ts       # Code + PR history indexer
│   └── retriever.ts     # Context retrieval for agents
├── github/
│   └── client.ts        # PR fetching + comment posting
├── tools/
│   └── agent-tools.ts   # read_file, search_codebase, search_pr_history
├── prompts/
│   └── system-prompts.ts # JS/TS/React-specific review prompts
├── types/
│   └── index.ts
├── config.ts
├── orchestrator.ts      # Main pipeline coordinator
└── index.ts             # CLI entry point
```

## CLI Reference

```bash
# Index codebase for RAG
npm run index -- --path /path/to/repo

# Index PR history (bugfix learning)
npm run index-prs -- --max 200

# Review a PR (console output)
npm run review -- --pr 123

# Review and post to GitHub
npm run review -- --pr 123 --post

# Review with JSON output
npm run review -- --pr 123 --json

# Save results to file
npm run review -- --pr 123 --output results.json
```

## Cost Estimates

| PR Size | Agents | Approx. Cost |
|---|---|---|
| Small (< 50 lines) | 1 (Haiku/Flash) | ~$0.01 |
| Standard (50-300 lines) | 3-4 (Sonnet/Pro) | ~$0.50 |
| Large (300-1000 lines) | 5 + verification | ~$1.50 |
| Extra-large (1000+ lines) | 5 + verification | ~$2.50 |

## Architecture Guide

For a deep dive into why this architecture was chosen over single-agent review, LangGraph, RAG-only approaches, and other patterns — including error handling strategies, token optimization, and boundary design — see [Code_Review_Agent_Architecture_Guide.md](./Code_Review_Agent_Architecture_Guide.md).

## License

MIT
