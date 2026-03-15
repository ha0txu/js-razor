# Review Rules

> Place this file in your repository root. The code review agent reads it
> to understand your team's priorities and conventions.

## Review Priorities (ordered)

1. **Security vulnerabilities** — Always flag. Injection, auth bypass, data exposure, secret leakage.
2. **Logic errors** — Bugs that cause incorrect behavior in production.
3. **Missing error handling** — Unhandled promise rejections, empty catch blocks, missing validation.
4. **Performance on hot paths** — N+1 queries, render storms, memory leaks, event loop blocking.
5. **React anti-patterns** — Hook violations, stale closures, missing cleanup, key prop issues.

## Do NOT Flag

- Formatting/style issues (handled by ESLint/Prettier)
- Minor naming preferences
- TODO/FIXME comments (tracked separately)
- Test coverage gaps (unless for critical business logic)
- Import ordering

## Framework Conventions

- **React version**: 18+ (concurrent features available)
- **State management**: [e.g., Zustand / Redux Toolkit / React Context]
- **Data fetching**: [e.g., React Query / SWR / tRPC]
- **Routing**: [e.g., Next.js App Router / React Router v6]
- **Validation**: [e.g., Zod / Yup / Joi]
- **Testing**: [e.g., Vitest / Jest + React Testing Library]

## Architecture Rules

- Components in `src/components/` should be presentation-only
- Business logic belongs in `src/hooks/` or `src/services/`
- API routes must validate all input with Zod schemas
- Database queries must use parameterized statements (never string concat)
- Environment variables accessed only through `src/config.ts`

## Known Sensitive Paths

- `src/auth/` — Authentication/authorization (always review carefully)
- `src/api/` — External-facing API endpoints
- `src/middleware/` — Express/Next.js middleware
- `src/utils/crypto.ts` — Cryptographic operations
