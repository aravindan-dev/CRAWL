/**
 * Minimal JSON salvage for model output. With Ollama structured output the
 * response is already schema-constrained, so this is a thin safety net for the
 * occasional stray code-fence or trailing prose — NOT a full JSON parser.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  // Strip ```json ... ``` fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(body);
  } catch {
    // Fall back to the first balanced { … } or [ … ] span.
    const start = body.search(/[[{]/);
    if (start === -1) throw new Error("No JSON value found in model output");
    const open = body[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(body.slice(start, i + 1));
        }
      }
    }
    throw new Error("Unbalanced JSON in model output");
  }
}
