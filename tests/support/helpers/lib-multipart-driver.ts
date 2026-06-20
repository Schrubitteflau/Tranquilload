import type { BrowserContext, Route } from "@playwright/test"

/**
 * Shared PW-Lib harness for Story 11.5 (chaos cluster).
 *
 * Two halves:
 *
 *   1. `driveMultipartInPage` — a SELF-CONTAINED function executed via
 *      `page.evaluate`. It wires REAL presigned multipart callbacks (initiate /
 *      sign+PUT / complete / reconcile) against the test-app + MinIO and returns
 *      a fully serializable summary (event tags, per-part attempt counts, the
 *      typed terminal error, abort latency). It must NOT reference any
 *      module-scope binding — Playwright serializes it via `.toString()` and
 *      runs it in the browser realm. It reads the lib from
 *      `window.__tlBench__` (see examples/test-app/src/bench.ts).
 *
 *   2. `installPutChaos` / `installApiDelay` — TEST-SIDE `context.route`
 *      installers. The browser PUTs parts DIRECTLY to MinIO (`:9000`) via
 *      presigned URLs, so PUT-level chaos (fail / abort / fulfill / latency)
 *      cannot go through the Fastify `/api/chaos` endpoint — it is injected at
 *      the browser network layer here, hermetically per browser context.
 *
 * MEMORY: AbortSignal must be wired into user callbacks — the driver threads the
 * controller's signal into every `fetch`, matching the test-app's
 * `makeMultipartCallbacks(file, ctx, signal?)` (Story 10.8).
 */

// ---------------------------------------------------------------------------
// In-page driver contract (all fields structured-clone serializable)
// ---------------------------------------------------------------------------

export interface DriveArgs {
  readonly filename: string
  readonly totalBytes: number
  readonly chunkSize: number
  readonly maxConcurrency?: number
  readonly withReconcile?: boolean
  /**
   * Override the lib's default retry schedule (3 attempts, exponential 100ms).
   * Built in-browser from `window.__tlBench__.Schedule`/`Duration`.
   */
  readonly retry?: {
    readonly delayMs: number
    readonly recurs: number
    readonly kind?: "exponential" | "spaced"
  }
  /** Optional abort orchestration (the driver owns the AbortController). */
  readonly abort?: {
    readonly when:
      | "firstPartFailure"
      | "duringFirstPart"
      | "duringInitiate"
      | "afterPart"
      | "afterPartCallback"
      | "duringComplete"
    readonly afterPart?: number
  }
}

export interface SerializedUploadError {
  readonly _tag?: string
  readonly name?: string
  readonly message?: string
  readonly partNumber?: number
  readonly totalAttempts?: number
  readonly causeMessage?: string
}

export interface DriveResult {
  readonly ok: boolean
  readonly error: SerializedUploadError | null
  /** `_tag` of every UploadEvent, in emission order. */
  readonly events: string[]
  /** Count of PartCompleted events drained from the live `events` stream.
   * Story 13.5 made the events stream flush-before-error, so events emitted
   * before a failure/abort are now observable here too (it no longer closes
   * empty on the abort path). `partsCompletedViaCallback` is RETAINED as the
   * primary abort signal — defense-in-depth, and the deterministic flush is
   * locked at the unit tier (core `13.5-INT-001/002`) rather than re-asserted
   * across these nightly 3-engine chaos specs. */
  readonly completedParts: number
  /** Parts whose `uploadPart` callback returned an ETag — direct proof of
   * partial progress, independent of the event stream (the primary abort-path
   * progress signal; see `completedParts` re: the Story 13.5 flush). */
  readonly partsCompletedViaCallback: number
  /** partNumber → number of times `uploadPart` was invoked (proves retries). */
  readonly partAttempts: Record<string, number>
  readonly uploadId: string | null
  readonly key: string | null
  /** ms between `controller.abort()` and the terminal rejection (abort tests). */
  readonly abortLatencyMs: number | null
}

/**
 * SELF-CONTAINED — do not reference outer scope. Runs in the browser via
 * `page.evaluate(driveMultipartInPage, args)`.
 */
export async function driveMultipartInPage(args: DriveArgs): Promise<DriveResult> {
  interface BenchApi {
    uploadMultipart: (opts: Record<string, unknown>) => {
      uploadId: Promise<string>
      result: Promise<unknown>
      events: ReadableStream<{ _tag: string }>
    }
    Schedule: {
      exponential: (d: unknown) => unknown
      spaced: (d: unknown) => unknown
      recurs: (n: number) => unknown
      compose: (other: unknown) => (self: unknown) => unknown
    }
    Duration: { millis: (n: number) => unknown }
  }
  const w = window as unknown as { __tlBench__: BenchApi }
  const { uploadMultipart, Schedule, Duration } = w.__tlBench__

  const serializeError = (e: unknown): SerializedUploadError => {
    const o = (e ?? {}) as Record<string, unknown>
    let causeMessage: string | undefined
    try {
      const c = o.cause as { message?: string } | undefined
      causeMessage = c ? (c.message ?? String(c)) : undefined
    } catch {
      causeMessage = undefined
    }
    return {
      _tag: o._tag as string | undefined,
      name: o.name as string | undefined,
      message: o.message as string | undefined,
      partNumber: o.partNumber as number | undefined,
      totalAttempts: o.totalAttempts as number | undefined,
      causeMessage,
    }
  }

  const makeStream = (total: number, sub: number): ReadableStream<Uint8Array> => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) {
          c.close()
          return
        }
        const n = Math.min(sub, total - sent)
        const u = new Uint8Array(n)
        for (let i = 0; i < n; i++) u[i] = (sent + i) & 0xff
        sent += n
        c.enqueue(u)
      },
    })
  }

  const events: string[] = []
  const partAttempts: Record<string, number> = {}
  let completedParts = 0
  let partsCompletedViaCallback = 0
  const ctx = { key: "", uploadId: "" }
  const controller = new AbortController()
  const signal = controller.signal

  let abortT0: number | null = null
  // First-write-wins: `abortLatencyMs` is measured from the EARLIEST abort
  // trigger (matters only if a future spec fires multiple triggers, e.g.
  // maxConcurrency>1 with several parts failing at once).
  const fireAbort = (): void => {
    if (abortT0 === null) abortT0 = performance.now()
    controller.abort()
  }

  let resolveFirstFailure!: () => void
  const firstFailure = new Promise<void>((r) => (resolveFirstFailure = r))
  let resolveFirstPutStarted!: () => void
  const firstPutStarted = new Promise<void>((r) => (resolveFirstPutStarted = r))
  let resolveInitiateStarted!: () => void
  const initiateStarted = new Promise<void>((r) => (resolveInitiateStarted = r))
  let resolveCompleteStarted!: () => void
  const completeStarted = new Promise<void>((r) => (resolveCompleteStarted = r))

  const initiate = async (): Promise<{ uploadId: string }> => {
    if (ctx.uploadId) return { uploadId: ctx.uploadId }
    resolveInitiateStarted()
    const res = await fetch("/api/multipart/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: args.filename }),
      signal,
    })
    if (!res.ok) throw new Error(`initiate failed: HTTP ${res.status}`)
    const data = (await res.json()) as { uploadId: string; key: string }
    ctx.uploadId = data.uploadId
    ctx.key = data.key
    return { uploadId: data.uploadId }
  }

  const uploadPart = async (partNumber: number, chunk: Uint8Array): Promise<string> => {
    partAttempts[partNumber] = (partAttempts[partNumber] ?? 0) + 1
    try {
      const signRes = await fetch("/api/multipart/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: ctx.key, uploadId: ctx.uploadId, partNumber }),
        signal,
      })
      if (!signRes.ok) throw new Error(`sign failed: HTTP ${signRes.status}`)
      const { url } = (await signRes.json()) as { url: string }
      resolveFirstPutStarted()
      const putRes = await fetch(url, { method: "PUT", body: chunk, signal })
      if (!putRes.ok) throw new Error(`PUT part ${partNumber} failed: HTTP ${putRes.status}`)
      const etag = putRes.headers.get("ETag")
      if (!etag) throw new Error(`PUT part ${partNumber}: missing ETag`)
      partsCompletedViaCallback += 1
      if (
        args.abort?.when === "afterPartCallback" &&
        partsCompletedViaCallback === (args.abort.afterPart ?? 1)
      ) {
        fireAbort()
      }
      return etag.replace(/"/g, "")
    } catch (e) {
      resolveFirstFailure()
      throw e
    }
  }

  const completeUpload = async (
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ): Promise<void> => {
    resolveCompleteStarted()
    const res = await fetch("/api/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: ctx.key, uploadId, parts }),
      signal,
    })
    if (!res.ok) throw new Error(`complete failed: HTTP ${res.status}`)
  }

  const reconcileCompletedParts = async (): Promise<
    ReadonlyArray<{ partNumber: number; etag: string }>
  > => {
    const res = await fetch(
      `/api/multipart/parts?key=${encodeURIComponent(ctx.key)}&uploadId=${encodeURIComponent(ctx.uploadId)}`,
      { signal },
    )
    if (!res.ok) throw new Error(`list parts failed: HTTP ${res.status}`)
    const data = (await res.json()) as { parts: ReadonlyArray<{ partNumber: number; etag: string }> }
    return data.parts
  }

  let retrySchedule: unknown
  if (args.retry) {
    const base =
      args.retry.kind === "spaced"
        ? Schedule.spaced(Duration.millis(args.retry.delayMs))
        : Schedule.exponential(Duration.millis(args.retry.delayMs))
    const composed = Schedule.compose(Schedule.recurs(args.retry.recurs)) as (s: unknown) => unknown
    retrySchedule = composed(base)
  }

  const opts: Record<string, unknown> = {
    stream: makeStream(args.totalBytes, 1024 * 1024),
    totalBytes: args.totalBytes,
    chunkSize: args.chunkSize,
    maxConcurrency: args.maxConcurrency ?? 1,
    signal,
    initiate,
    uploadPart,
    completeUpload,
  }
  if (args.withReconcile) opts.reconcileCompletedParts = reconcileCompletedParts
  if (retrySchedule !== undefined) opts.retrySchedule = retrySchedule

  const handle = uploadMultipart(opts)
  handle.uploadId.then((id) => (ctx.uploadId = ctx.uploadId || id)).catch(() => {})

  if (args.abort?.when === "firstPartFailure") void firstFailure.then(fireAbort)
  if (args.abort?.when === "duringFirstPart") void firstPutStarted.then(fireAbort)
  if (args.abort?.when === "duringInitiate") void initiateStarted.then(fireAbort)
  if (args.abort?.when === "duringComplete") void completeStarted.then(fireAbort)

  const drain = (async () => {
    const reader = handle.events.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      events.push(value._tag)
      if (value._tag === "PartCompleted") {
        completedParts += 1
        if (args.abort?.when === "afterPart" && completedParts === (args.abort.afterPart ?? 1)) {
          fireAbort()
        }
      }
    }
  })()

  let ok = false
  let error: SerializedUploadError | null = null
  let abortLatencyMs: number | null = null
  try {
    await handle.result
    ok = true
  } catch (e) {
    error = serializeError(e)
    if (abortT0 !== null) abortLatencyMs = performance.now() - abortT0
  }
  await drain.catch(() => {})

  return {
    ok,
    error,
    events,
    completedParts,
    partsCompletedViaCallback,
    partAttempts,
    uploadId: ctx.uploadId || null,
    key: ctx.key || null,
    abortLatencyMs,
  }
}

// ---------------------------------------------------------------------------
// Test-side chaos installers (context.route)
// ---------------------------------------------------------------------------

/** A presigned MinIO PUT, with the partNumber parsed from the URL query. */
export interface PutChaosInfo {
  readonly route: Route
  readonly partNumber: number
  /** 1-based attempt count for this partNumber across the whole context. */
  readonly attempt: number
}

/**
 * Intercept every presigned part PUT to MinIO (`:9000`). The `decide` callback
 * owns the route action (continue / abort / fulfill / delay). Non-PUT requests
 * to MinIO (and everything else) pass through untouched.
 *
 * Returns the live per-part attempt map so specs can assert retry counts.
 */
export async function installPutChaos(
  context: BrowserContext,
  decide: (info: PutChaosInfo) => Promise<void>,
): Promise<Map<number, number>> {
  const attempts = new Map<number, number>()
  await context.route(
    (url) => url.port === "9000",
    async (route) => {
      const req = route.request()
      if (req.method() !== "PUT") {
        await route.continue()
        return
      }
      const partNumber = Number(new URL(req.url()).searchParams.get("partNumber") ?? "0")
      const attempt = (attempts.get(partNumber) ?? 0) + 1
      attempts.set(partNumber, attempt)
      await decide({ route, partNumber, attempt })
    },
  )
  return attempts
}

/**
 * Delay a test-app `/api/*` endpoint (initiate / complete) so an abort fired
 * mid-request lands while the request is genuinely in flight.
 */
export async function installApiDelay(
  context: BrowserContext,
  pathFragment: string,
  delayMs: number,
): Promise<void> {
  await context.route(
    (url) => url.pathname.includes(pathFragment),
    async (route) => {
      await new Promise((r) => setTimeout(r, delayMs))
      await route.continue()
    },
  )
}
