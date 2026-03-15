import * as fs from "node:fs";
import type { CodeChunk } from "../types/index.js";

/**
 * Parses JavaScript/TypeScript files into semantic chunks
 * (functions, classes, components, hooks, routes, etc.)
 * Uses regex-based heuristics — not a full AST parser —
 * for speed and zero native dependencies.
 *
 * For production, consider tree-sitter for higher accuracy.
 */

// ─── Regex patterns for JS/TS constructs ─────────────────────────────────────

const PATTERNS = {
  // React components: function Foo(...) or const Foo = (...) =>
  reactComponent: /^(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z]\w*)|(?:const|let)\s+([A-Z]\w*)\s*=\s*(?:\(|React\.(?:memo|forwardRef)))/,

  // React hooks: function useFoo(...) or const useFoo = (...)
  reactHook: /^(?:export\s+(?:default\s+)?)?(?:function\s+(use[A-Z]\w*)|(?:const|let)\s+(use[A-Z]\w*)\s*=)/,

  // Regular functions: function foo(...) or const foo = (...)  =>
  functionDecl: /^(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\()/,

  // Class declaration
  classDecl: /^(?:export\s+(?:default\s+)?)?class\s+(\w+)/,

  // Express/Koa routes
  routeHandler: /(?:app|router)\.(get|post|put|patch|delete|use)\s*\(/,

  // Express middleware
  middleware: /^(?:export\s+(?:default\s+)?)?(?:const|function)\s+(\w+).*?(?:req\s*,\s*res|Request\s*,\s*Response|NextFunction)/,

  // Test blocks
  testBlock: /^(?:describe|it|test|beforeEach|afterEach|beforeAll|afterAll)\s*\(/,

  // Module exports
  exportStatement: /^export\s+(?:default\s+|{)/,

  // Import statements
  importStatement: /^import\s+/,
};

interface ParseOptions {
  /** Maximum lines per chunk before splitting */
  maxChunkLines?: number;
}

/**
 * Parse a JS/TS file into semantic code chunks.
 */
export function parseFile(
  filePath: string,
  content?: string,
  options: ParseOptions = {},
): CodeChunk[] {
  const maxChunkLines = options.maxChunkLines ?? 150;
  const source = content ?? fs.readFileSync(filePath, "utf-8");
  const lines = source.split("\n");
  const chunks: CodeChunk[] = [];

  // Collect imports for context
  const imports = lines
    .filter((l) => PATTERNS.importStatement.test(l.trim()))
    .map((l) => l.trim());

  // Collect exports
  const exports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("export ")) {
      const match = trimmed.match(/export\s+(?:default\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/);
      if (match) exports.push(match[1]);
    }
  }

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Skip empty lines and standalone imports
    if (!trimmed || PATTERNS.importStatement.test(trimmed)) {
      i++;
      continue;
    }

    // Try to identify what this block is
    const detection = detectBlockType(trimmed);
    if (detection) {
      const blockEnd = findBlockEnd(lines, i, maxChunkLines);
      const blockContent = lines.slice(i, blockEnd + 1).join("\n");

      chunks.push({
        id: `${filePath}:${detection.name}:${i}`,
        file_path: filePath,
        content: blockContent,
        type: detection.type,
        name: detection.name,
        start_line: i + 1,  // 1-indexed
        end_line: blockEnd + 1,
        exports: exports.filter((e) => blockContent.includes(e)),
        imports,
      });

      i = blockEnd + 1;
      continue;
    }

    i++;
  }

  // If no chunks were found (e.g., a config file), treat the whole file as one chunk
  if (chunks.length === 0 && lines.length > 0) {
    chunks.push({
      id: `${filePath}:module:0`,
      file_path: filePath,
      content: source,
      type: "module",
      name: fileBaseName(filePath),
      start_line: 1,
      end_line: lines.length,
      exports,
      imports,
    });
  }

  return chunks;
}

interface DetectionResult {
  type: CodeChunk["type"];
  name: string;
}

function detectBlockType(line: string): DetectionResult | null {
  // Order matters: more specific patterns first

  let match = line.match(PATTERNS.reactHook);
  if (match) return { type: "hook", name: match[1] || match[2] };

  match = line.match(PATTERNS.reactComponent);
  if (match) return { type: "component", name: match[1] || match[2] };

  match = line.match(PATTERNS.classDecl);
  if (match) return { type: "class", name: match[1] };

  if (PATTERNS.testBlock.test(line)) {
    const nameMatch = line.match(/(?:describe|it|test)\s*\(\s*['"`](.+?)['"`]/);
    return { type: "test", name: nameMatch?.[1] ?? "test_block" };
  }

  if (PATTERNS.routeHandler.test(line)) {
    const routeMatch = line.match(/\.(get|post|put|patch|delete|use)\s*\(\s*['"`](.+?)['"`]/);
    return { type: "route", name: routeMatch ? `${routeMatch[1].toUpperCase()} ${routeMatch[2]}` : "route" };
  }

  match = line.match(PATTERNS.middleware);
  if (match) return { type: "middleware", name: match[1] };

  match = line.match(PATTERNS.functionDecl);
  if (match) return { type: "function", name: match[1] || match[2] };

  return null;
}

/**
 * Find the end of a code block by tracking brace depth.
 */
function findBlockEnd(lines: string[], start: number, maxLines: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = start; i < Math.min(lines.length, start + maxLines); i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === "{" || char === "(" && !foundOpen) {
        if (char === "{") {
          depth++;
          foundOpen = true;
        }
      }
      if (char === "{") depth++;
      if (char === "}") depth--;

      // Fix double-counting: we counted '{' twice above
    }

    // Simplified brace counting
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    if (i === start) {
      depth = opens - closes;
      if (opens > 0) foundOpen = true;
    } else {
      depth += opens - closes;
    }

    if (foundOpen && depth <= 0) {
      return i;
    }
  }

  // If we hit maxLines, return what we have
  return Math.min(lines.length - 1, start + maxLines - 1);
}

function fileBaseName(filePath: string): string {
  const parts = filePath.split("/");
  const file = parts[parts.length - 1];
  return file.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}
