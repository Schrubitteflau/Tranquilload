import { test, expect, chromium } from "@playwright/test"

/**
 * Story 11.2-E2E-001 (F#84) — Heap stability across 100 sequential uploads.
 *
 * R-P2-2 (HIGH, Score 6) — leaks observable only over long-running sessions.
 *
 * Strategy
 * --------
 *   - Chromium-only: `performance.memory` and the `--expose-gc` JS flag are
 *     non-standard. Firefox/WebKit skip cleanly.
 *   - Launches Chromium with `--js-flags=--expose-gc` so we can force a GC
 *     between samples and isolate genuine retention from collectable garbage.
 *   - Navigates to the test-app's bench page (`/bench.html`) which exposes
 *     `window.__tlBench__.uploadMultipart`. The lib is consumed via Vite's
 *     module-graph, identical to a real consumer.
 *   - Runs 100 sequential `uploadMultipart` calls in-memory (no network —
 *     callbacks return synchronously). Samples
 *     `performance.memory.usedJSHeapSize` at start, after 50, and after 100,
 *     forcing `gc()` before each sample. The heap MUST stay flat — the 100th
 *     sample is bounded above by 1.5× the first (tunable for noise).
 *
 * Scope (Pattern 3 from project_test_timing_boundary_patterns.md)
 * ---------------------------------------------------------------
 * `performance.memory` is coarse and noisy by design (precision is reduced by
 * the browser as a side-channel-attack mitigation). The 1.5× threshold is the
 * narrower honest lock — strict equality WILL flake. A genuine monotonic leak
 * (per-upload retained closure, listener accumulation, semaphore not collected)
 * pushes well past 1.5× over 100 iterations — that is the signal we lock here.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"

test.describe("11.2 — heap stability (R-P2-2, PW-Lib, Chromium-only)", () => {
  test("11.2-E2E-001 (F#84) — 100 sequential uploadMultipart calls keep heap flat (≤ 1.5× baseline)", async ({
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "performance.memory + --expose-gc are Chromium-only; Firefox/WebKit have no equivalent (Epic 11 out-of-scope per story 11.2 Dev Notes)",
    )
    test.slow()

    // Fresh launch — we need `--js-flags=--expose-gc` and
    // `--enable-precise-memory-info`. The shared `lib` project uses Desktop
    // Chrome defaults which lack both.
    const browser = await chromium.launch({
      args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
    })
    try {
      const page = await browser.newPage()
      await page.goto(`${BASE_URL}/bench.html`)

      // Wait for the bench page to expose the lib (Vite ESM module graph).
      await page.waitForFunction(
        () => typeof window.__tlBench__?.uploadMultipart === "function",
        undefined,
        { timeout: 15_000 },
      )

      type HeapSample = { iteration: number; usedJSHeapSize: number }
      const result = await page.evaluate(async (): Promise<{
        samples: HeapSample[]
        completed: number
        rejected: number
        gcAvailable: boolean
        preciseMemoryAvailable: boolean
      }> => {
        type W = typeof window & {
          gc?: () => void
          performance: Performance & { memory?: { usedJSHeapSize: number } }
        }
        const w = window as W
        const gcAvailable = typeof w.gc === "function"
        const preciseMemoryAvailable = typeof w.performance.memory?.usedJSHeapSize === "number"

        const forceGcAndSample = async (iteration: number): Promise<HeapSample> => {
          // Force GC twice — empirically the second pass collects what was
          // freed during the first pass's marking phase.
          if (gcAvailable) {
            w.gc!()
            await new Promise(r => setTimeout(r, 20))
            w.gc!()
            await new Promise(r => setTimeout(r, 20))
          }
          return {
            iteration,
            usedJSHeapSize: w.performance.memory?.usedJSHeapSize ?? 0,
          }
        }

        const tinyStream = (bytes: number): ReadableStream<Uint8Array> =>
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(bytes).fill(1))
              c.close()
            },
          })

        const runOne = async (i: number): Promise<void> => {
          const { result, events } = w.__tlBench__.uploadMultipart({
            stream: tinyStream(20_000),
            chunkSize: 10_000,
            uploadPart: () => `etag-${i}`,
            completeUpload: () => {},
          })
          // Drain events so the underlying ReadableStream isn't held by
          // backpressure — a real consumer would either drain or close.
          const reader = events.getReader()
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
          await result
        }

        const samples: HeapSample[] = []
        let completed = 0
        let rejected = 0

        samples.push(await forceGcAndSample(0))
        for (let i = 0; i < 100; i++) {
          try {
            await runOne(i)
            completed += 1
          } catch {
            rejected += 1
          }
          if (i === 49) samples.push(await forceGcAndSample(50))
        }
        samples.push(await forceGcAndSample(100))

        return { samples, completed, rejected, gcAvailable, preciseMemoryAvailable }
      })

      // Sanity: harness is correctly wired.
      expect(
        result.gcAvailable,
        "window.gc() must be exposed (Chromium needs --js-flags=--expose-gc)",
      ).toBe(true)
      expect(
        result.preciseMemoryAvailable,
        "performance.memory.usedJSHeapSize must be readable (Chromium needs --enable-precise-memory-info)",
      ).toBe(true)
      expect(result.completed, `expected all 100 uploads to succeed; got ${result.completed} completed / ${result.rejected} rejected`).toBe(100)
      expect(result.samples).toHaveLength(3)

      const [first, mid, last] = result.samples
      expect(first).toBeDefined()
      expect(mid).toBeDefined()
      expect(last).toBeDefined()
      // Baseline cannot be zero — would mean we can't read memory at all.
      expect(first!.usedJSHeapSize).toBeGreaterThan(0)

      // The heap is allowed to grow by ≤ 50% over 100 uploads. A genuine leak
      // (per-upload retained closure, listener accumulation) pushes WELL past
      // this bound.
      const ratio = last!.usedJSHeapSize / first!.usedJSHeapSize
      expect(
        ratio,
        `heap grew ${ratio.toFixed(2)}× over 100 uploads — leak suspected; samples=${JSON.stringify(result.samples)}`,
      ).toBeLessThan(1.5)

      // Light monotonicity check: the midpoint sample must also stay bounded —
      // otherwise a fast leak in the first 50 followed by a steady second half
      // could slip past the endpoint check.
      const midRatio = mid!.usedJSHeapSize / first!.usedJSHeapSize
      expect(
        midRatio,
        `heap grew ${midRatio.toFixed(2)}× by the 50-upload midpoint; samples=${JSON.stringify(result.samples)}`,
      ).toBeLessThan(1.5)
    } finally {
      await browser.close()
    }
  })
})
