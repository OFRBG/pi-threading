/** How the companion service revives a stopped thread when a deliverAfter
 *  envelope comes due. Kept SDK-free and pure so it's unit-testable without
 *  a restate-server.
 *
 *  The spawned `pi` must be told where its state lives: without
 *  `--thread-storage restate` it would boot against the local-fs backend and
 *  never see the thread it's supposed to revive. The service can't know the
 *  ingress URL its clients used, so it comes from the service's own
 *  environment:
 *
 *  - RESTATE_INGRESS_URL  — ingress the revived thread connects back to
 *                           (default http://localhost:8080)
 *  - PI_THREAD_EXTENSION  — path to this extension's entry point, passed as
 *                           `--extension`; omit if pi loads it from its own
 *                           config
 *  - PI_BIN               — pi executable to spawn (default "pi" from PATH).
 *                           Needed on Windows, where the npm-installed "pi"
 *                           is a .cmd shim spawn() can't execute — point it
 *                           at a real executable
 */
export function buildWakeLaunch(
  threadId: string,
  prompt: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): { cmd: string; args: string[]; cwd: string } {
  const args = [
    "--thread-id",
    threadId,
    "--thread-storage",
    "restate",
    "--thread-storage-url",
    env.RESTATE_INGRESS_URL ?? "http://localhost:8080",
  ];
  if (env.PI_THREAD_EXTENSION) args.push("--extension", env.PI_THREAD_EXTENSION);
  // The revived process boots, drains its inbox (which now contains the due
  // envelope), and sees this prompt — so a wake reads identically whether or
  // not the process survived to see it.
  args.push("--print", prompt);
  return { cmd: env.PI_BIN ?? "pi", args, cwd };
}
