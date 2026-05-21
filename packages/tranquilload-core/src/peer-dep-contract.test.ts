import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { LoggerService } from "./services/logger-service.js"

/**
 * Story 10.8-INT-002 — Effect singleton Tag identity (F#77).
 *
 * The peer-dependency declaration on `effect` exists to keep ONE copy of
 * `effect` resolved in the consumer's `node_modules`. Without it, two copies
 * silently coexist (one for `@tranquilload/core`, one for the application),
 * and a number of class-identity invariants break.
 *
 * This test locks down the underlying mechanism that the peer-dep prevents:
 *
 * 1. `Context.Tag(key)()` returns a NEW class object every time it is
 *    evaluated. Two effect copies → two evaluations → two distinct Tag
 *    classes for the same `LoggerService`. This breaks any code that relies
 *    on `instanceof`, brand types, or compile-time class identity.
 *
 * 2. Effect's runtime context lookup IS key-based (`unsafeGet` uses
 *    `tag.key`), so two same-key Tags do interop for `yield* Tag` and
 *    `Layer.succeed`. This is the LIMIT of how far the dual-copy scenario
 *    fails-soft — and a fact we lock down here so a future Effect change
 *    (e.g. switching to identity-based lookup) doesn't silently break the
 *    peer-dep contract's failure modes.
 *
 * The dual-copy hazard is therefore not "Layers stop connecting" but the
 * combination of: bundle bloat, version skew across copies, class-identity
 * drift for `Fiber`/`Cause`/`Exit`/internal services, and Tag class identity
 * for code that uses Tags as brands. The peer-dep flag guards all of these.
 */
describe("Story 10.8-INT-002 — peer-dep contract (Effect Context.Tag identity)", () => {
  it("F#77 — `Context.Tag(key)()` produces a distinct class object on every evaluation", () => {
    class CopyA extends Context.Tag("@tranquilload/LoggerService")<
      CopyA,
      { readonly log: (level: string, message: string) => void }
    >() {}
    class CopyB extends Context.Tag("@tranquilload/LoggerService")<
      CopyB,
      { readonly log: (level: string, message: string) => void }
    >() {}

    // Two distinct class objects — the singleton invariant that the peer-dep
    // declaration preserves (one effect copy ⇒ one evaluation ⇒ one class).
    expect(CopyA).not.toBe(CopyB)
    expect(LoggerService).not.toBe(CopyA)
    expect(LoggerService).not.toBe(CopyB)

    // Same string key — what makes runtime lookup still work (next test).
    expect(CopyA.key).toBe("@tranquilload/LoggerService")
    expect(CopyB.key).toBe("@tranquilload/LoggerService")
    expect(LoggerService.key).toBe("@tranquilload/LoggerService")
  })

  it.effect("Effect runtime context lookup IS key-based — same-key Tags from different evaluations interop via Layer", () =>
    Effect.gen(function* () {
      class CopyA extends Context.Tag("Doc/Service")<
        CopyA,
        { readonly v: string }
      >() {}
      class CopyB extends Context.Tag("Doc/Service")<
        CopyB,
        { readonly v: string }
      >() {}

      // Layer registered against CopyA, lookup performed via CopyB.
      // We have to widen the program's requirement to CopyA (since that's
      // what Layer.succeed types against) — but at runtime, the cast doesn't
      // matter; only `tag.key` is consulted by `Context.unsafeGet`.
      const layer = Layer.succeed(CopyA, { v: "from-A" })

      const programNeedingB = Effect.gen(function* () {
        const svc = yield* CopyB
        return svc.v
      })

      // Cast required because TS doesn't know the two Tags are
      // runtime-interchangeable; in the real dual-copy scenario the user
      // doesn't write this cast because each copy provides its own TS module.
      const provided = Effect.provide(
        programNeedingB as Effect.Effect<string, never, CopyA>,
        layer,
      )

      const value = yield* provided
      expect(
        value,
        "Effect.unsafeGet keys on tag.key — same-key Tags must interop, even across evaluations.",
      ).toBe("from-A")
    }),
  )

  it.effect("F#77 — sanity check: canonical Layer satisfies canonical Tag", () =>
    Effect.gen(function* () {
      const layer = Layer.succeed(LoggerService, {
        log: (_level, _msg) => {},
      })
      const program = Effect.gen(function* () {
        const svc = yield* LoggerService
        svc.log("info", "ok")
        return "ok"
      })
      const value = yield* Effect.provide(program, layer)
      expect(value).toBe("ok")
    }),
  )
})
