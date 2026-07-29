/** Uniform tool-error payload: message for the model, ok:false for callers. */
export function err(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ok: false },
  };
}
