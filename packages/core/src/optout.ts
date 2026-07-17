/**
 * Deterministic opt-out detection (plan: compliance §1, blueprint §11).
 *
 * This runs BEFORE the LLM ever sees an inbound message. Compliance decisions
 * are never delegated to the model. Ambiguity resolves toward opting out.
 */

const KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke"];
const HELP_KEYWORDS = ["help", "info"];

// Free-text withdrawal patterns. Intentionally broad; false positives here are
// safe (we stop contacting), false negatives are a compliance violation.
const WITHDRAWAL_PATTERNS: RegExp[] = [
  /\bdo\s*n('|o)?t\s+(contact|text|message|call|email)\s+me\b/i,
  /\bstop\s+(texting|messaging|contacting|calling|emailing)\b/i,
  /\bremove\s+(me|my\s+(number|info|details))\b/i,
  /\btake\s+me\s+off\b/i,
  /\bno\s+(more|further)\s+(messages|texts|contact)\b/i,
  /\bleave\s+me\s+alone\b/i,
  /\bunsubscribe\s+me\b/i,
  /\bnot\s+interested\b.*\b(stop|remove|contact)\b/i,
];

export interface OptOutMatch {
  isOptOut: boolean;
  isHelp: boolean;
  matchedBy?: "keyword" | "freetext";
  matchedValue?: string;
}

export function detectOptOut(rawBody: string): OptOutMatch {
  const body = rawBody.trim();
  const normalized = body.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();

  // Exact keyword match (whole message is the keyword, allowing punctuation).
  const firstWord = normalized.split(" ")[0] ?? "";
  if (KEYWORDS.includes(normalized) || KEYWORDS.includes(firstWord)) {
    return { isOptOut: true, isHelp: false, matchedBy: "keyword", matchedValue: firstWord };
  }

  for (const pattern of WITHDRAWAL_PATTERNS) {
    if (pattern.test(body)) {
      return {
        isOptOut: true,
        isHelp: false,
        matchedBy: "freetext",
        matchedValue: pattern.source,
      };
    }
  }

  if (HELP_KEYWORDS.includes(normalized)) {
    return { isOptOut: false, isHelp: true };
  }

  return { isOptOut: false, isHelp: false };
}
