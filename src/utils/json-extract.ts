/**
 * Robust JSON extraction from LLM text output.
 *
 * LLMs (especially Gemini 3.x thinking models) often wrap JSON in:
 *   - Markdown code blocks (```json ... ```)
 *   - Explanatory text before/after the JSON
 *   - Reasoning steps followed by the actual output
 *   - Truncated output (max_tokens hit mid-JSON)
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
  if (greedyMatch) {
    try { JSON.parse(greedyMatch[0]); return greedyMatch[0]; } catch { /* fall through */ }
  }

  // Strategy 4: Truncated JSON recovery — response was likely cut off by max_tokens.
  // Find the start of the array and salvage all complete JSON objects within it.
  const repaired = repairTruncatedArray(text);
  if (repaired) {
    console.warn("  [json-extract] Recovered truncated JSON array — response may have been cut off by max_tokens");
    return repaired;
  }

  return null;
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
  if (greedyMatch) {
    try { JSON.parse(greedyMatch[0]); return greedyMatch[0]; } catch { /* fall through */ }
  }

  return null;
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

/**
 * Attempt to recover complete items from a truncated JSON array.
 *
 * When the LLM hits max_tokens, the output is cut mid-JSON like:
 *   [{ "file": "a.ts", ... }, { "file": "b.ts", ... }, { "file": "c.ts", "tit
 *
 * This function finds all complete top-level objects within the array
 * and reconstructs a valid JSON array from them.
 */
function repairTruncatedArray(text: string): string | null {
  const arrayStart = text.indexOf("[");
  if (arrayStart === -1) return null;

  // Walk through the text after '[', collecting complete top-level objects
  const items: string[] = [];
  let i = arrayStart + 1;

  while (i < text.length) {
    // Skip whitespace and commas
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === "]") break;

    if (text[i] === "{") {
      // Try to find the balanced closing brace for this object
      const objStr = findBalancedBrackets(text.slice(i), "{", "}");
      if (objStr) {
        // Verify it's actually valid JSON
        try {
          JSON.parse(objStr);
          items.push(objStr);
          i += objStr.length;
        } catch {
          // Object found but not valid JSON — skip it
          break;
        }
      } else {
        // Unbalanced braces — this object was truncated, stop here
        break;
      }
    } else {
      // Unexpected character — stop
      break;
    }
  }

  if (items.length === 0) return null;
  return `[${items.join(",")}]`;
}
