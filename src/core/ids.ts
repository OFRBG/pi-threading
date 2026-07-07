let seq = 0;

/** Mint a correlation/barrier/wake id. A raw `Date.now()` collides when two
 *  ids are minted in the same millisecond (easy with sequential awaits on a
 *  fast disk); the process-lifetime counter disambiguates within a process,
 *  and the caller-supplied prefix carries the thread id for uniqueness
 *  across processes. The format is opaque — nothing parses these. */
export function mintId(prefix: string): string {
  return `${prefix}.${Date.now()}.${(seq++).toString(36)}`;
}
