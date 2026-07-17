/**
 * Message template rendering (plan: blueprint §5C, PLAN M3).
 * Simple, safe {{variable}} substitution. Unknown variables render empty and
 * are reported so a template referencing a missing field never ships silently.
 */

export interface RenderResult {
  text: string;
  missing: string[];
}

export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>,
): RenderResult {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null || value === "") {
      missing.push(key);
      return "";
    }
    return value;
  });
  return { text: text.replace(/\s{2,}/g, " ").trim(), missing };
}
