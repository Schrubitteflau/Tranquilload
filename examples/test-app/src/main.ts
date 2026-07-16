import { uploadMultipart } from "@tranquilload/core/multipart"
import { uploadOnce } from "@tranquilload/core/oneshot"
import { compress } from "@tranquilload/core/pipeline"
import { fromFile } from "@tranquilload/adapters/fromFile"
import type { UploadEvent } from "@tranquilload/core/progress"
import { Duration, Schedule } from "effect"

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fileInput        = $<HTMLInputElement>("file")
const fileInfo         = $<HTMLParagraphElement>("file-info")
const startBtn         = $<HTMLButtonElement>("start")
const abortBtn         = $<HTMLButtonElement>("abort")
const chunkSizeInput   = $<HTMLInputElement>("chunk-size")
const concurrencyInput = $<HTMLInputElement>("concurrency")
const compressInput    = $<HTMLInputElement>("compress")
const progressFill     = $<HTMLDivElement>("progress-fill")
const progressText     = $<HTMLParagraphElement>("progress-text")
const uploadIdDisplay  = $<HTMLParagraphElement>("upload-id-display")
const logEl            = $<HTMLPreElement>("log")
const resumeBanner     = $<HTMLElement>("resume-banner")
const resumeInfo       = $<HTMLParagraphElement>("resume-info")
const resumeBtn        = $<HTMLButtonElement>("resume")
const dismissResumeBtn = $<HTMLButtonElement>("dismiss-resume")
const clearResumeBtn   = $<HTMLButtonElement>("clear-resume")
const applyChaosBtn    = $<HTMLButtonElement>("apply-chaos")
const chaosFailSign     = $<HTMLInputElement>("chaos-fail-sign")
const chaosFailComplete = $<HTMLInputElement>("chaos-fail-complete")
const chaosSlowSign     = $<HTMLInputElement>("chaos-slow-sign")

// ---------- State ----------
const RESUME_KEY = "tranquilload:resume"
interface ResumeState {
  uploadId: string
  key: string
  filename: string
  size: number
  chunkSize: number
}

let currentAbort: AbortController | null = null

// ---------- Debug toggles (Story 11.4 persona harness) ----------
// Activated via query params so the PW-UI persona specs can drive documented
// foot-gun paths without a separate build. Every toggle is a no-op unless
// explicitly enabled, so normal manual use is unaffected.
const DEBUG_PARAMS = new URLSearchParams(window.location.search)
const DEBUG = {
  // P#B1 (11.4-E2E-004): fire-and-forget uploadMultipart() with NO `await result`.
  forgotAwait: DEBUG_PARAMS.get("forgotAwait") === "1",
  // P#B5 (11.4-E2E-005): call getProgress() INSIDE part-1 uploadPart (expects 0 bytes).
  probeGetProgressFromPartOne: DEBUG_PARAMS.get("probeGetProgressFromPartOne") === "1",
  // P#B6 (11.4-E2E-006) / P#A4 (11.4-E2E-003): inject a custom retrySchedule of
  // `Schedule.recurs(retryRecurs)` with a fixed `retryFixedMs` delay per retry.
  retryFixedMs: DEBUG_PARAMS.has("retryFixedMs") ? Number(DEBUG_PARAMS.get("retryFixedMs")) : null,
  retryRecurs: DEBUG_PARAMS.has("retryRecurs") ? Number(DEBUG_PARAMS.get("retryRecurs")) : null,
}

/**
 * Build the custom retry schedule from the debug query params, or `undefined`
 * to fall back to the library default. `recurs(n)` caps the retry count and
 * `addDelay` makes every retry wait a fixed `retryFixedMs` (vs the default
 * exponential backoff) — exactly what P#B6 asserts end-to-end.
 */
function debugRetrySchedule() {
  if (DEBUG.retryFixedMs == null || DEBUG.retryRecurs == null) return undefined
  // `Schedule<number, unknown>` — assignable to the lib's
  // `Schedule<unknown, PartUploadError>` retrySchedule slot (Out widens to
  // unknown; In stays contravariantly compatible).
  return Schedule.recurs(DEBUG.retryRecurs).pipe(
    Schedule.addDelay(() => Duration.millis(DEBUG.retryFixedMs!)),
  )
}

// ---------- Helpers ----------
function log(line: string): void {
  const time = new Date().toISOString().slice(11, 23)
  logEl.textContent = `[${time}] ${line}\n${logEl.textContent}`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

function updateProgress(uploaded: number, total: number | null): void {
  if (total) {
    const pct = Math.min(100, (uploaded / total) * 100)
    progressFill.style.width = `${pct}%`
    progressText.textContent = `${fmtBytes(uploaded)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`
  } else {
    progressText.textContent = `${fmtBytes(uploaded)} uploaded (total unknown)`
  }
}

function setUiBusy(busy: boolean): void {
  startBtn.disabled = busy
  abortBtn.disabled = !busy
  fileInput.disabled = busy
}

function saveResume(state: ResumeState): void {
  localStorage.setItem(RESUME_KEY, JSON.stringify(state))
}

function loadResume(): ResumeState | null {
  const raw = localStorage.getItem(RESUME_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as ResumeState } catch { return null }
}

function clearResume(): void {
  localStorage.removeItem(RESUME_KEY)
  resumeBanner.hidden = true
}

// ---------- Server callbacks (multipart) ----------
interface MultipartContext {
  key: string
  uploadId: string
}

function makeMultipartCallbacks(file: File, ctx: MultipartContext, signal?: AbortSignal) {
  const initiate = async (): Promise<{ uploadId: string }> => {
    if (ctx.uploadId) {
      log(`Reusing uploadId ${ctx.uploadId} (resume)`)
      return { uploadId: ctx.uploadId }
    }
    const res = await fetch("/api/multipart/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
      signal,
    })
    if (!res.ok) throw new Error(`initiate failed: HTTP ${res.status}`)
    const data = await res.json() as { uploadId: string; key: string }
    ctx.uploadId = data.uploadId
    ctx.key = data.key
    return { uploadId: data.uploadId }
  }

  const uploadPart = async (partNumber: number, chunk: Uint8Array): Promise<string> => {
    const signRes = await fetch("/api/multipart/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: ctx.key, uploadId: ctx.uploadId, partNumber }),
      signal,
    })
    if (!signRes.ok) throw new Error(`sign failed: HTTP ${signRes.status}`)
    const { url } = await signRes.json() as { url: string }

    // `chunk` is a Uint8Array; the DOM `BodyInit` type (via @types/node) does
    // not include it — cast per the project's BodyInit convention (type-only).
    const putRes = await fetch(url, { method: "PUT", body: chunk as unknown as BodyInit, signal })
    if (!putRes.ok) throw new Error(`PUT part ${partNumber} failed: HTTP ${putRes.status}`)
    const etag = putRes.headers.get("ETag")
    if (!etag) throw new Error(`PUT part ${partNumber}: missing ETag`)
    return etag.replace(/"/g, "")
  }

  const completeUpload = async (
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>
  ): Promise<void> => {
    const res = await fetch("/api/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: ctx.key, uploadId, parts }),
      signal,
    })
    if (!res.ok) throw new Error(`complete failed: HTTP ${res.status}`)
  }

  const reconcileCompletedParts = async (): Promise<ReadonlyArray<{ partNumber: number; etag: string }>> => {
    const res = await fetch(
      `/api/multipart/parts?key=${encodeURIComponent(ctx.key)}&uploadId=${encodeURIComponent(ctx.uploadId)}`,
      { signal }
    )
    if (!res.ok) throw new Error(`list parts failed: HTTP ${res.status}`)
    const data = await res.json() as { parts: ReadonlyArray<{ partNumber: number; etag: string }> }
    log(`Reconciled ${data.parts.length} parts already on server`)
    return data.parts
  }

  return { initiate, uploadPart, completeUpload, reconcileCompletedParts }
}

// ---------- Upload runners ----------
async function runMultipart(file: File, resumeFrom: ResumeState | null): Promise<void> {
  setUiBusy(true)
  logEl.textContent = ""
  log(`Starting multipart upload: ${file.name} (${fmtBytes(file.size)})`)

  const { stream, totalBytes } = fromFile(file)
  const chunkSize = Math.max(5, Number(chunkSizeInput.value)) * 1024 * 1024
  const maxConcurrency = Math.max(1, Number(concurrencyInput.value))

  const ctx: MultipartContext = resumeFrom
    ? { key: resumeFrom.key, uploadId: resumeFrom.uploadId }
    : { key: "", uploadId: "" }

  currentAbort = new AbortController()
  const callbacks = makeMultipartCallbacks(file, ctx, currentAbort.signal)

  // P#B5 foot-gun probe: call getProgress() from INSIDE part-1's uploadPart,
  // i.e. BEFORE the post-uploadPart `Ref.update` for part 1 has run. The
  // snapshot must read 0 bytes (the documented MEMORY foot-gun). `handle` is
  // assigned synchronously below, well before any uploadPart callback fires.
  let handle: ReturnType<typeof uploadMultipart> | null = null
  const uploadPart = DEBUG.probeGetProgressFromPartOne
    ? async (partNumber: number, chunk: Uint8Array): Promise<string> => {
        if (partNumber === 1 && handle) {
          const snap = await handle.getProgress()
          log(`getProgress() inside uploadPart part=1 → bytesUploaded=${snap.bytesUploaded}`)
        }
        return callbacks.uploadPart(partNumber, chunk)
      }
    : callbacks.uploadPart

  handle = uploadMultipart({
    stream,
    totalBytes,
    chunkSize,
    maxConcurrency,
    signal: currentAbort.signal,
    initiate: callbacks.initiate,
    uploadPart,
    completeUpload: callbacks.completeUpload,
    reconcileCompletedParts: resumeFrom ? callbacks.reconcileCompletedParts : undefined,
    pipeline: compressInput.checked ? compress("deflate-raw") : undefined,
    retrySchedule: debugRetrySchedule(),
  })

  const { uploadId, result, events } = handle

  uploadId.then((id) => {
    uploadIdDisplay.textContent = `uploadId: ${id}`
    saveResume({
      uploadId: id,
      key: ctx.key,
      filename: file.name,
      size: file.size,
      chunkSize,
    })
  }).catch(() => {})

  // Drain the events stream
  ;(async () => {
    const reader = events.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      handleEvent(value, totalBytes)
    }
  })().catch((e) => log(`event stream error: ${e}`))

  try {
    await result
    log(`✅ Upload completed`)
    clearResume()
  } catch (err) {
    const e = err as { _tag?: string; message?: string }
    log(`❌ ${e._tag ?? "Error"}: ${e.message ?? String(err)}`)
  } finally {
    setUiBusy(false)
    currentAbort = null
  }
}

// P#B1 foot-gun (11.4-E2E-004): fire uploadMultipart() and DELIBERATELY never
// `await result` (nor drain `events`, nor try/catch). The rejected `result`
// promise has no consumer, so on failure it escapes to the global
// `unhandledrejection` handler — proving the dangling failure is OBSERVABLE
// (a regression that silently swallowed it would be a data-loss foot-gun). We
// install a one-time global listener so the escape surfaces in the UI log
// deterministically across all three browsers.
function runMultipartForgotAwait(file: File): void {
  setUiBusy(true)
  logEl.textContent = ""
  log(`Starting multipart upload (forgot-await foot-gun): ${file.name} (${fmtBytes(file.size)})`)

  const onUnhandled = (ev: PromiseRejectionEvent): void => {
    const e = ev.reason as { _tag?: string; message?: string }
    log(`UNHANDLED REJECTION: ${e?._tag ?? "Error"}: ${e?.message ?? String(ev.reason)}`)
    setUiBusy(false)
    currentAbort = null
  }
  window.addEventListener("unhandledrejection", onUnhandled, { once: true })

  const { stream, totalBytes } = fromFile(file)
  const chunkSize = Math.max(5, Number(chunkSizeInput.value)) * 1024 * 1024
  const ctx: MultipartContext = { key: "", uploadId: "" }
  currentAbort = new AbortController()
  const callbacks = makeMultipartCallbacks(file, ctx, currentAbort.signal)

  // No `await`, no events drain, no try/catch — that omission IS the foot-gun.
  uploadMultipart({
    stream,
    totalBytes,
    chunkSize,
    maxConcurrency: 1,
    signal: currentAbort.signal,
    initiate: callbacks.initiate,
    uploadPart: callbacks.uploadPart,
    completeUpload: callbacks.completeUpload,
  })
}

function handleEvent(event: UploadEvent, total: number): void {
  switch (event._tag) {
    case "UploadInitiated":
      log(`→ UploadInitiated  uploadId=${event.uploadId}`)
      break
    case "PartCompleted":
      log(`→ PartCompleted    part=${event.partNumber} bytes=${fmtBytes(event.bytesUploaded)} etag=${event.etag.slice(0, 12)}…`)
      break
    case "ProgressTick":
      updateProgress(event.bytesUploaded, total)
      break
    case "CircuitOpen":
      log(`⚠ CircuitOpen      failedParts=${event.failedParts}`)
      break
    case "UploadCompleted":
      log(`→ UploadCompleted  totalParts=${event.totalParts}`)
      break
  }
}

async function runOneshot(file: File): Promise<void> {
  setUiBusy(true)
  logEl.textContent = ""
  log(`Starting one-shot upload: ${file.name} (${fmtBytes(file.size)})`)
  updateProgress(0, file.size)

  const { stream } = fromFile(file)
  currentAbort = new AbortController()

  const { result, events } = uploadOnce({
    stream,
    signal: currentAbort.signal,
    // Use the raw File as the request body to sidestep browser streaming
    // body limitations (fetch + ReadableStream needs `duplex: 'half'` + HTTP/2).
    upload: async (_stream) => {
      const res = await fetch(
        `/api/oneshot?filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type)}`,
        { method: "PUT", body: file, signal: currentAbort?.signal }
      )
      if (!res.ok) throw new Error(`one-shot upload failed: HTTP ${res.status}`)
    },
  })

  ;(async () => {
    const reader = events.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      handleEvent(value, file.size)
    }
  })().catch((e) => log(`event stream error: ${e}`))

  try {
    await result
    updateProgress(file.size, file.size)
    log(`✅ Upload completed`)
  } catch (err) {
    const e = err as { _tag?: string; message?: string }
    log(`❌ ${e._tag ?? "Error"}: ${e.message ?? String(err)}`)
  } finally {
    setUiBusy(false)
    currentAbort = null
  }
}

// ---------- UI wiring ----------
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0]
  fileInfo.textContent = file ? `${file.name} — ${fmtBytes(file.size)} — ${file.type || "unknown type"}` : ""
})

startBtn.addEventListener("click", () => {
  const file = fileInput.files?.[0]
  if (!file) { log("Pick a file first"); return }
  const mode = (document.querySelector<HTMLInputElement>("input[name=mode]:checked"))?.value
  if (mode === "oneshot") void runOneshot(file)
  else if (DEBUG.forgotAwait) runMultipartForgotAwait(file)
  else void runMultipart(file, null)
})

abortBtn.addEventListener("click", () => {
  currentAbort?.abort()
  log("Abort requested")
})

resumeBtn.addEventListener("click", () => {
  const state = loadResume()
  const file = fileInput.files?.[0]
  if (!state) return
  if (!file) { log("Pick the SAME file again to resume"); return }
  if (file.name !== state.filename || file.size !== state.size) {
    log(`File mismatch — expected ${state.filename} (${state.size} bytes)`)
    return
  }
  resumeBanner.hidden = true
  void runMultipart(file, state)
})

dismissResumeBtn.addEventListener("click", () => { resumeBanner.hidden = true })
clearResumeBtn.addEventListener("click", () => {
  clearResume()
  log("Cleared saved resume state")
})

applyChaosBtn.addEventListener("click", async () => {
  const body = {
    failSignNextN: Number(chaosFailSign.value),
    failCompleteNextN: Number(chaosFailComplete.value),
    slowSignMs: Number(chaosSlowSign.value),
  }
  const res = await fetch("/api/chaos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  log(`Chaos updated: ${JSON.stringify(data)}`)
})

// On load: surface any pending resume state
;(() => {
  const state = loadResume()
  if (state) {
    resumeInfo.textContent = `${state.filename} (${fmtBytes(state.size)}) · uploadId=${state.uploadId}`
    resumeBanner.hidden = false
  }
})()
