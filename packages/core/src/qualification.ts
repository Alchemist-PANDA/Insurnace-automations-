/**
 * Qualification schema logic (plan: conversation-engine §6). Pure functions the
 * orchestrator uses to decide the next question and whether qualification is
 * complete. The LLM phrases and interprets; these functions decide flow.
 */

export interface QualificationField {
  key: string;
  required: boolean;
  question: string;
}

export interface QualificationSchema {
  key: string;
  fields: readonly QualificationField[];
}

export type QualificationAnswers = Record<string, unknown>;

function isAnswered(answers: QualificationAnswers, key: string): boolean {
  const v = answers[key];
  return v !== undefined && v !== null && v !== "";
}

/** The next unanswered field to ask about, in schema order (required first). */
export function nextQuestion(
  schema: QualificationSchema,
  answers: QualificationAnswers,
): QualificationField | null {
  const required = schema.fields.filter((f) => f.required);
  const optional = schema.fields.filter((f) => !f.required);
  for (const f of [...required, ...optional]) {
    if (!isAnswered(answers, f.key)) return f;
  }
  return null;
}

/** Qualification is complete when every REQUIRED field has an answer. */
export function isQualificationComplete(
  schema: QualificationSchema,
  answers: QualificationAnswers,
): boolean {
  return schema.fields
    .filter((f) => f.required)
    .every((f) => isAnswered(answers, f.key));
}

/** Merge newly extracted facts over existing answers (non-null wins). */
export function mergeAnswers(
  existing: QualificationAnswers,
  extracted: QualificationAnswers,
): QualificationAnswers {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(extracted)) {
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
  }
  return merged;
}
