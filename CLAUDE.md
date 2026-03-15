# Project Context

> Place this file in your repository root. The code review agent reads it
> to understand your system architecture and conventions.

## Project Overview

[Brief description of what this application does]

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Frontend**: React 18 + [Next.js 14 / Vite]
- **Backend**: [Node.js + Express / Next.js API routes / tRPC]
- **Database**: [PostgreSQL / MongoDB / etc.]
- **ORM**: [Prisma / Drizzle / Mongoose / etc.]
- **Auth**: [NextAuth / Auth0 / Custom JWT / etc.]
- **Deployment**: [Vercel / AWS / Docker / etc.]

## Directory Structure

```
src/
├── app/          # Next.js app router pages
├── components/   # React components (presentational)
├── hooks/        # Custom React hooks
├── lib/          # Shared utilities and helpers
├── services/     # Business logic and external API clients
├── api/          # API route handlers
├── middleware/    # Express/Next.js middleware
├── types/        # TypeScript type definitions
└── config.ts     # Environment variable access
```

## Key Patterns

- [e.g., "We use the repository pattern for database access"]
- [e.g., "All API responses follow the { data, error, meta } shape"]
- [e.g., "Components use composition over prop drilling"]
- [e.g., "Server components are default; 'use client' only when needed"]

## Known Issues / Tech Debt

- [e.g., "Legacy auth module in src/auth/legacy.ts — being migrated"]
- [e.g., "Some API routes still use callback-style error handling"]
