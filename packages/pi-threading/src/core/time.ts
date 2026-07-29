export function nowIso(): string {
  return new Date().toISOString();
}

/** Convert a user-facing `deadlineSeconds`/`fireInSeconds` offset into the
 *  absolute ISO timestamp stored in state; undefined stays undefined. */
export function deadlineFromSeconds(seconds?: number): string | undefined {
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
}
