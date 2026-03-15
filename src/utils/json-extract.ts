/**
 * Robust JSON extraction from LLM text output.
 *
 * LLMs (especially Gemini 3.x thinking models) often wrap JSON in:
 *   - Markdown code blocks (```json ... ```)
 *   - Explanatory text before/after the JSON
 *   - Reasoning steps followed by the actual output
 *
 * These helpers handle all of those cases.
 */

/**
 * Extract a JSON array string from LLM output.
 * Tries multiple strategies in order of reliability.
 */
export function extractJsonArray(text: string): string | null {
  // Strategy 1: Extract from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith("[")) {
      try { JSON.parse(inner); return inner; } catch { /* fall through */ }
    }
  }

  // Strategy 2: Find balanced JSON array using bracket counting
  const balanced = findBalancedBrackets(text, "[", "]");
  if (balanced) {
    try { JSON.parse(balanced); return balanced; } catch { /* fall through */ }
  }

  // Strategy 3: Greedy regex fallback
  const greedyMatch = text.match(/\[[\s\S]*\]/);
  return greedyMatch ? greedyMatch[0] : null;
}

/**
 * Extract a JSON object string from LLM output.
 * Used by the ranking agent which returns { findings, summary }.
 */
export function extractJsonObject(text: string): string | null {
  // Strategy 1: Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith("{")) {
      try { JSON.parse(inner); return inner; } catch { /* fall through */ }
    }
  }

  // Strategy 2: Find balanced JSON object using bracket counting
  const balanced = findBalancedBrackets(text, "{", "}");
  if (balanced) {
    try { JSON.parse(balanced); return balanced; } catch { /* fall through */ }
  }

  // Strategy 3: Greedy regex fallback
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  return greedyMatch ? greedyMatch[0] : null;
}

/**
 * Find a balanced bracket-delimited substring in text.
 * Handles nested brackets and string escaping.
 */
function findBalancedBrackets(
  text: string,
  open: string,
  close: string,
): string | null {
  const firstBracket = text.indexOf(open);
  if (firstBracket === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBracket; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(firstBracket, i + 1);
      }
    }
  }

  return null;
}
