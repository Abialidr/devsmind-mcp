/**
 * Extracts the outermost JSON structure (object or array) from a string.
 * This handles cases where the LLM wraps JSON in markdown blocks (e.g. ```json ... ```)
 * or outputs conversational text before/after the actual JSON response.
 */
export function extractJsonBlock(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code block wrappers if present
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.substring(firstNewline + 1);
    } else {
      cleaned = cleaned.substring(3);
    }

    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    cleaned = cleaned.trim();
  }

  // Locate the start of the JSON object or array
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  let endChar: '}' | ']' = '}';

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endChar = '}';
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endChar = ']';
  }

  if (startIdx === -1) {
    return cleaned; // Fallback to raw text if no JSON character is found
  }

  const lastEndIdx = cleaned.lastIndexOf(endChar);
  if (lastEndIdx !== -1 && lastEndIdx > startIdx) {
    return cleaned.substring(startIdx, lastEndIdx + 1);
  }

  // If there's a starting brace/bracket but no matching ending brace/bracket,
  // return from the start index to the end (repairJson will close it).
  return cleaned.substring(startIdx);
}

/**
 * Repairs a truncated or incomplete JSON string by closing unclosed string literals
 * and appending matching closing braces/brackets for any unclosed structures.
 */
export function repairJson(str: string): string {
  let s = str.trim();
  if (!s) return '{}';

  let inString = false;
  let isEscaped = false;
  const stack: ('{' | '[')[] = [];

  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
        isEscaped = false;
      } else if (char === '{') {
        stack.push('{');
      } else if (char === '[') {
        stack.push('[');
      } else if (char === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
        }
      } else if (char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
        }
      }
    }
  }

  // If the string ended with a dangling escape backslash, remove it
  // so it doesn't escape the closing quote we are about to add.
  if (inString && s.endsWith('\\') && isEscaped) {
    s = s.slice(0, -1);
  }

  let repaired = s;
  if (inString) {
    repaired += '"';
  }

  // Close open brackets/braces in reverse order
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') {
      repaired += '}';
    } else if (open === '[') {
      repaired += ']';
    }
  }

  return repaired;
}

/**
 * Safely parses a JSON string, extracting the JSON block and repairing it if necessary.
 * Returns the fallback value if parsing fails.
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  if (!text || typeof text !== 'string') {
    return fallback;
  }

  try {
    // 1. Direct parse check
    return JSON.parse(text) as T;
  } catch (err) {
    // Direct parse failed, let's try extraction and repair
    try {
      const extracted = extractJsonBlock(text);
      return JSON.parse(extracted) as T;
    } catch (err2) {
      try {
        const extracted = extractJsonBlock(text);
        const repaired = repairJson(extracted);
        return JSON.parse(repaired) as T;
      } catch (err3) {
        // Logging the parsing failure so developers are aware
        console.warn(`[JSON Parse Warning] Failed to parse repaired JSON. Error: ${(err3 as Error).message}`);
        return fallback;
      }
    }
  }
}
