import { test, expect, chromium, firefox, webkit, type BrowserType } from "@playwright/test"

/**
 * Story 11.7 — 11.7-E2E-002 (F#40 / G#2) — `simpleHttpUpload` streaming body
 * across Chromium / Firefox / WebKit (PW-Lib harness).
 *
 * Codifies R-P2-4 / Decision D1 / Epic 13 candidate.
 *
 * `simpleHttpUpload` (default mode) sends a `ReadableStream` fetch body with
 * `duplex: "half"`. This spec EMPIRICALLY probes the per-engine behaviour and
 * locks the CURRENT cross-browser matrix.
 *
 * Measured behaviour on the Playwright-bundled engines (2026):
 *
 *   - CONSTRUCTION (`new Request(url, { body: stream, duplex: "half" })`)
 *     succeeds in ALL THREE engines — the historical "Firefox/WebKit throw on a
 *     stream body" construction gap has closed.
 *   - TRANSMISSION over plain HTTP/1.1 still fails outside Chromium: request
 *     streams require HTTP/2, so an actual streamed PUT to an HTTP/1.1 endpoint
 *     rejects in Firefox/WebKit (and in Chromium too against an HTTP/1.1
 *     server). This is the remaining gap.
 *
 * The remaining transmission gap (negotiating HTTP/2, or a per-engine buffered
 * fallback) is an Epic 13 candidate. Flip this matrix to "streamed PUT
 * transmits in all engines" once that fix ships.
 */

interface StreamBodyProbe {
  /** `new Request(url, { body: stream, duplex: "half" })` succeeded. */
  requestConstructed: boolean
  /**
   * Control: a NON-streamed (buffered Uint8Array) PUT to the same endpoint
   * resolved. Proves the endpoint is reachable, so a streamed-PUT failure can
   * be attributed to the HTTP/1.1 streaming gap rather than to connectivity.
   */
  bufferedTransmitted: boolean
  /** An actual streamed `fetch(...)` over HTTP/1.1 resolved without throwing. */
  transmittedOverHttp1: boolean
  constructError?: string
  bufferedError?: string
  transmitError?: string
}

async function probeStreamingBody(
  browserType: BrowserType,
  http1Endpoint: string,
): Promise<StreamBodyProbe> {
  const browser = await browserType.launch()
  try {
    const page = await browser.newPage()
    // Navigate to the endpoint's ORIGIN so the probe fetches are SAME-ORIGIN.
    // From `about:blank` a cross-origin fetch to the HTTP/1.1 server is
    // CORS-blocked and would surface as a generic NetworkError — masking the
    // streaming-vs-buffered distinction we are trying to measure.
    await page.goto(new URL(http1Endpoint).origin)
    return await page.evaluate(async (endpoint: string) => {
      const makeStream = () => new Response(new Uint8Array([1, 2, 3])).body!

      // Step 1 — construction.
      let requestConstructed = false
      let constructError: string | undefined
      try {
        const req = new Request(endpoint, {
          method: "PUT",
          body: makeStream() as unknown as BodyInit,
          duplex: "half",
        } as RequestInit & { duplex: "half" })
        void req.method
        requestConstructed = true
      } catch (e) {
        const err = e as { name?: string; message?: string }
        constructError = `${err.name}: ${err.message}`
      }

      // Step 2 — buffered control PUT (no stream). A 404/405 RESPONSE counts as
      // "reachable"; only a thrown network error means unreachable.
      let bufferedTransmitted = false
      let bufferedError: string | undefined
      try {
        const res = await fetch(endpoint, {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
        })
        await res.text().catch(() => "")
        bufferedTransmitted = true
      } catch (e) {
        const err = e as { name?: string; message?: string }
        bufferedError = `${err.name}: ${err.message}`
      }

      // Step 3 — actual streamed transmission over plain HTTP/1.1.
      let transmittedOverHttp1 = false
      let transmitError: string | undefined
      try {
        const res = await fetch(endpoint, {
          method: "PUT",
          body: makeStream() as unknown as BodyInit,
          duplex: "half",
        } as RequestInit & { duplex: "half" })
        // Drain/await to force the body to actually be sent.
        await res.text().catch(() => "")
        transmittedOverHttp1 = true
      } catch (e) {
        const err = e as { name?: string; message?: string }
        transmitError = `${err.name}: ${err.message}`
      }

      return {
        requestConstructed,
        bufferedTransmitted,
        transmittedOverHttp1,
        constructError,
        bufferedError,
        transmitError,
      }
    }, http1Endpoint)
  } finally {
    await browser.close()
  }
}

// The Vite dev server (BASE_URL) is a reachable HTTP/1.1 endpoint. A 404/405
// response is fine — we only care whether the streamed body is ACCEPTED for
// transmission, not the status code.
const HTTP1_ENDPOINT = `${process.env.BASE_URL ?? "http://localhost:5173"}/__stream-probe`

test.describe("R-P2-4 — `simpleHttpUpload` streaming body cross-browser (PW-Lib)", () => {
  test("11.7-E2E-002 (F#40) [chromium] — constructs a stream-body request with duplex:'half'", async () => {
    const probe = await probeStreamingBody(chromium, HTTP1_ENDPOINT)
    // CURRENT BEHAVIOUR: Chromium supports request-stream construction.
    expect(
      probe.requestConstructed,
      `Chromium should construct a stream-body Request — got ${probe.constructError}`,
    ).toBe(true)
  })

  test("11.7-E2E-002 (F#40) [firefox] — constructs a stream-body request with duplex:'half'", async () => {
    const probe = await probeStreamingBody(firefox, HTTP1_ENDPOINT)
    // CURRENT BEHAVIOUR: the construction-level gap has closed in Firefox; the
    // remaining gap is HTTP/1.1 transmission (Epic 13 candidate).
    expect(
      probe.requestConstructed,
      `Firefox stream-body Request construction — got ${probe.constructError}`,
    ).toBe(true)
  })

  test("11.7-E2E-002 (F#40) [webkit] — constructs a stream-body request with duplex:'half'", async () => {
    const probe = await probeStreamingBody(webkit, HTTP1_ENDPOINT)
    expect(
      probe.requestConstructed,
      `WebKit stream-body Request construction — got ${probe.constructError}`,
    ).toBe(true)
  })

  test("11.7-E2E-002 (F#40) — TRANSMISSION gap: a streamed PUT over HTTP/1.1 does NOT succeed in every engine (codifies R-P2-4)", async () => {
    // The cross-browser gap that R-P2-4 tracks lives at TRANSMISSION, not
    // construction. Over plain HTTP/1.1, at least one non-Chromium engine
    // fails to transmit a streamed body (request streams need HTTP/2). We lock
    // that the matrix is NOT uniformly green today.
    const [fx, wk] = await Promise.all([
      probeStreamingBody(firefox, HTTP1_ENDPOINT),
      probeStreamingBody(webkit, HTTP1_ENDPOINT),
    ])

    // Precondition — the endpoint must be REACHABLE (buffered PUT resolves) in
    // both engines. Without this control a network error (endpoint down) would
    // set transmittedOverHttp1=false and pass the negative lock for the WRONG
    // reason. We require connectivity before attributing failure to streaming.
    expect(
      fx.bufferedTransmitted,
      `Firefox buffered PUT must reach the endpoint to evaluate the streaming gap — got ${fx.bufferedError}`,
    ).toBe(true)
    expect(
      wk.bufferedTransmitted,
      `WebKit buffered PUT must reach the endpoint to evaluate the streaming gap — got ${wk.bufferedError}`,
    ).toBe(true)

    // The failure must be SPECIFIC to streaming: at least one engine transmits a
    // buffered body but NOT a streamed one (proves it's the HTTP/1.1 streaming
    // gap, not connectivity).
    const streamingSpecificGap =
      (fx.bufferedTransmitted && !fx.transmittedOverHttp1) ||
      (wk.bufferedTransmitted && !wk.transmittedOverHttp1)
    expect(
      streamingSpecificGap,
      `Expected at least one of Firefox/WebKit to accept a buffered PUT but reject a ` +
        `streamed one over HTTP/1.1 (fx: buffered=${fx.bufferedTransmitted} streamed=${fx.transmittedOverHttp1}; ` +
        `wk: buffered=${wk.bufferedTransmitted} streamed=${wk.transmittedOverHttp1}).`,
    ).toBe(true)

    // Epic 13 candidate: flip to `.toBe(true)` for all engines when the
    // cross-browser streaming-transmission fix ships.
    const bothTransmitted = fx.transmittedOverHttp1 && wk.transmittedOverHttp1
    expect(
      bothTransmitted,
      `Firefox/WebKit streamed PUT over HTTP/1.1 unexpectedly BOTH succeeded ` +
        `(fx=${fx.transmitError ?? "ok"}, wk=${wk.transmitError ?? "ok"}). ` +
        `The Epic 13 cross-browser transmission fix may have landed — flip this matrix.`,
    ).toBe(false)
  })
})
