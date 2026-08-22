/**
 * The container health probe.
 *
 * A FILE, not a `node -e` one-liner, and the reason is worth recording. The
 * probe used to live inline in docker-compose.yml:
 *
 *   test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3001/…"]
 *
 * By the time it reached a running container, twenty-nine characters in the
 * middle had gone missing, and every probe failed with a SyntaxError while
 * the API underneath was perfectly healthy — eighteen consecutive failures
 * that said nothing about the service. A long single-quoted JavaScript string
 * nested inside a YAML array inside a shell copy-paste has too many layers
 * that can quietly drop a substring, and none of them tell you they did.
 *
 * As a committed file it is version-controlled, testable (see
 * healthcheck.test.ts), and referenced by an exec-form HEALTHCHECK that needs
 * no quoting at all.
 *
 * It reads API_PORT so it cannot drift from the port the server actually
 * binds, and targets 127.0.0.1 explicitly rather than `localhost`, which can
 * resolve to ::1 while the server listens only on IPv4.
 */

const DEFAULT_PORT = 3001;

/** True when the API answers 200. Any other outcome — including a refused connection — is false. */
export async function checkHealth(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 200;
  } catch {
    // A refused connection, a DNS failure and a timeout are all "not healthy".
    // There is nothing a probe can usefully distinguish between them.
    return false;
  }
}

export function healthUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env.API_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}/api/v1/health`;
}

// Run only when invoked directly, so the test can import the functions above
// without the module exiting the process out from under it.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit((await checkHealth(healthUrl())) ? 0 : 1);
}
