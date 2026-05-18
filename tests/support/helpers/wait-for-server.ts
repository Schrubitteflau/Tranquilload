/**
 * Poll the test-app `/api/health` endpoint until it responds 200, or fail.
 *
 * The Playwright `webServer` block already waits on the Vite dev server URL,
 * but the Fastify backend starts independently. Use this in fixtures that
 * actually exercise the backend.
 */
export async function waitForServer(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  throw new Error(
    `waitForServer: ${url} not ready within ${timeoutMs}ms (last error: ${String(lastError)})`,
  )
}
