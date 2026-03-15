#!/bin/bash
# ─── Code Review Agent Setup Script ─────────────────────────────────────────
# Usage: bash setup.sh /path/to/your/repo
#
# This script copies the review agent into your repository's
# .github/code-review-agent/ directory and sets up the workflow files.

set -e

TARGET_REPO="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$TARGET_REPO/.git" ]; then
  echo "Error: $TARGET_REPO is not a git repository"
  exit 1
fi

echo "📦 Setting up Code Review Agent in: $TARGET_REPO"

# Create directories
mkdir -p "$TARGET_REPO/.github/code-review-agent/src"
mkdir -p "$TARGET_REPO/.github/workflows"

# Copy source code
cp -r "$SCRIPT_DIR/src/"* "$TARGET_REPO/.github/code-review-agent/src/"
cp "$SCRIPT_DIR/package.json" "$TARGET_REPO/.github/code-review-agent/"
cp "$SCRIPT_DIR/tsconfig.json" "$TARGET_REPO/.github/code-review-agent/"

# Copy workflow files
cp "$SCRIPT_DIR/.github/workflows/code-review.yml" "$TARGET_REPO/.github/workflows/"
cp "$SCRIPT_DIR/.github/workflows/index-pr-history.yml" "$TARGET_REPO/.github/workflows/"

# Copy templates (only if they don't exist)
if [ ! -f "$TARGET_REPO/REVIEW.md" ]; then
  cp "$SCRIPT_DIR/REVIEW.md" "$TARGET_REPO/"
  echo "  Created REVIEW.md (customize this with your team's rules)"
fi

if [ ! -f "$TARGET_REPO/CLAUDE.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE.md" "$TARGET_REPO/"
  echo "  Created CLAUDE.md (describe your project architecture here)"
fi

echo ""
echo "✅ Setup complete! Next steps:"
echo ""
echo "  1. Add GitHub Secrets (Settings → Secrets → Actions):"
echo "     - GEMINI_API_KEY"
echo "     - OPENAI_API_KEY"
echo ""
echo "  2. Edit REVIEW.md and CLAUDE.md to match your project"
echo ""
echo "  3. Commit and push:"
echo "     cd $TARGET_REPO"
echo "     git add .github/ REVIEW.md CLAUDE.md"
echo "     git commit -m 'feat: add AI code review agent'"
echo "     git push"
echo ""
echo "  4. Open a PR — the review agent will run automatically!"
