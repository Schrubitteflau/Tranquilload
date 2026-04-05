---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-03-08'
inputDocuments:
  - 'INITIAL_PROMPT.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md'
  - 'effect/docs/index.md'
workflowType: 'architecture'
project_name: 'Tranquilload'
user_name: 'Grochonnou'
date: '2026-03-08'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**

1. **One-shot upload** — Envoyer un fichier en une seule requête HTTP. API séparée de l'API multipart, sans unification forcée.

2. **Multipart upload** — Découper un flux binaire en chunks, uploader les parts en parallèle via callbacks utilisateur, collecter les confirmations, déclencher `completeUpload`. Le core est agnostique au protocole sous-jacent.

3. **Pipeline de transformations** — Chaque transformation est `(stream: Stream<Uint8Array>) => Stream<Uint8Array>`. Composables : compression, checksum, encryption. Backpressure gérée nativement par Effect/Stream.

4. **Compression côté client** — `CompressionService` injectable. Implémentation par défaut : `globalThis.CompressionStream`. Remplaçable par WASM, zlib, ou no-op.

5. **Observabilité/progression** — `Stream<UploadEvent>` retourné par les fonctions d'upload. Pull-mode complémentaire via `getProgress()`. Throttle/debounce = responsabilité utilisateur.

6. **Résilience** — Retry par part via `Effect.Schedule` injectable. Politiques différenciées selon le type d'erreur. Circuit Breaker optionnel.

7. **Résumabilité inter-session** — `uploadId` exposé dès `initiate`. Callback optionnel `reconcileCompletedParts` pour réconcilier l'état côté serveur. L'identité upload est responsabilité de l'utilisateur.

8. **Adapters** — `fileAdapter`, `fromNodeReadable`, `s3MultipartUploader`, `simpleHttpUpload`. Un adapter = `(options) => options`. Les contraintes protocolaires (ex : taille minimale de part S3) vivent dans l'adapter, jamais dans le core.

**Non-Functional Requirements:**

- **Tree-shaking** : exports granulaires. Un utilisateur Node n'embarque pas de code browser.
- **Bundle size minimal** : zéro dépendances runtime dans `@tranquilload/core` sauf `effect`.
- **Runtime agnostique** : `globalThis` uniquement — compatible Node 18+, browser, Bun, Deno.
- **Zéro état mutable exposé** : tout l'état dans des `Effect.Ref` locaux, invisibles à l'extérieur.
- **Silence par défaut** : `LoggerService` injectable, no-op en production.
- **TypeScript strict** : types exportés, erreurs = union fermée exhaustive en interne.
- **Adoption progressive sans Effect** : tous les callbacks utilisateur peuvent être des fonctions classiques (`Promise<T>`, ou `throw`). Le core normalise en interne. L'utilisateur n'a jamais à écrire une ligne d'Effect s'il ne le souhaite pas.

**Scale & Complexity:**

- Primary domain: TypeScript library / npm package
- Complexity level: Medium (périmètre borné, contraintes techniques non-triviales)
- Estimated architectural components: ~12 modules dans 2 packages

### Technical Constraints & Dependencies

- **`effect`** : peer dependency obligatoire. Toute orchestration async, retry, abort, état passe par Effect — en interne.
- **WHATWG Streams API** : `ReadableStream`, `TransformStream`, `WritableStream` comme primitives. Disponibles Node 18+, browser, Bun, Deno.
- **`globalThis.CompressionStream`** : disponible Node 18+, browser, Bun — jamais via `window`.
- **AbortController** : interop standard avec `Effect.interrupt`.
- **Pas de framework** : aucune dépendance à React, Next.js, ou équivalent.

### Cross-Cutting Concerns Identified

1. **Normalisation des erreurs** — Tout callback utilisateur (Promise, throw, Effect) est normalisé en `Effect` en interne. L'union `UploadError` est le contrat interne, pas l'API publique.
2. **Observabilité** — `Stream<UploadEvent>` traversant core et adapters.
3. **Abort/cancellation** — `AbortSignal` → `Effect.interrupt` propagé à tous les niveaux.
4. **Runtime detection** — `globalThis` uniquement. S'applique à CompressionService et adapters sources.
5. **Immutabilité** — `Effect.Ref` pour tout état interne. Aucune propriété mutable exposée.
6. **Progressive disclosure** — Services Effect injectables pour tous les points d'extension (Compression, Logger, Schedule).

## Starter Template Evaluation

### Primary Technology Domain

TypeScript npm library — monorepo à 2 packages (`@tranquilload/core`, `@tranquilload/adapters`).
Pas de starter CLI générique applicable : la "fondation" est un ensemble de choix de tooling.

### Starter Options Considered

| Outil | Statut | Verdict |
|-------|--------|---------|
| tsup | Abandonné par son auteur | ❌ Déconseillé |
| tsdown | Successeur de tsup, basé Rolldown/Oxc, ESM-first | ✅ Sélectionné |
| unbuild | UnJS ecosystem, Rollup-based | ⚠️ Viable, moins de momentum |
| Turborepo | Build orchestration monorepo | ✅ Inclus (2 packages) |

### Selected Foundation: pnpm workspaces + tsdown + vitest

**Rationale :** tsdown est ESM-first par défaut (aligné tree-shaking), maintenance active,
requiert `isolatedDeclarations: true` (TS 5.5+) ce qui force des exports typés propres —
bénéfique pour une lib publique. pnpm workspaces suffit pour 2 packages ;
Turborepo apporte la parallélisation des builds et le cache.

**Initialisation du projet :**

```bash
# Monorepo root
pnpm init
pnpm add -D typescript vitest turbo tsdown

# Packages
mkdir -p packages/core packages/adapters
cd packages/core && pnpm init
cd packages/adapters && pnpm init
```

**Architectural Decisions Provided by this Foundation:**

**Language & Runtime:**
- TypeScript strict, `isolatedDeclarations: true` (requis par tsdown pour les types)
- Target: ES2022, module: NodeNext

**Build Tooling:**
- tsdown — génère CJS + ESM + `.d.ts` via Oxc
- Sorties : `dist/esm/`, `dist/cjs/`, `dist/types/`
- Exports map dans `package.json` avec conditions `import`/`require`/`types`

**Testing:**
- vitest — compatible Effect, ESM natif

**Code Organization:**
```
packages/
  core/         → @tranquilload/core (Effect, WHATWG Streams, zéro autre dep)
  adapters/     → @tranquilload/adapters (dépend de core en workspace:^ peerDep)
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
```

**Development Experience:**
- pnpm workspace:^ (peerDep) / workspace:* (devDep) pour les dépendances inter-packages
- Turborepo pipeline : build → test (avec cache)
- tsconfig.base.json partagé, étendu par chaque package

**Note:** Le scaffolding de cette structure devrait être la première story d'implémentation.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Public API surface : Dual API (Web/Promise + `.effect` escape hatch)
- Error surface externe : `UploadError extends Error` avec `_tag` readonly literal
- Structure des exports : granulaire par sous-chemin, sans `/core/` dans le chemin
- Package naming : `@tranquilload` (core) + `@tranquilload/adapters`

**Important Decisions (Shape Architecture):**
- Versioning : indépendant entre les deux packages (peer dep `^X.Y.Z` ; seul un major core bump requiert une mise à jour dans adapters)
- Changelog : Changesets
- CI/CD : GitHub Actions (ci + release workflows)

**Deferred Decisions (Post-MVP):**
- Packages supplémentaires (`@tranquilload/background`, etc.)
- Versions indépendantes si les packages divergent significativement

---

### API Design

**Décision : Dual API — Web/Promise par défaut, Effect via escape hatch**

L'API publique principale retourne des types Web standard, accessibles sans connaissance d'Effect :

```ts
// API principale — Promise + ReadableStream
const { events, result } = uploadMultipart(options)
// result  : Promise<UploadResult>
// events  : ReadableStream<UploadEvent>

// Escape hatch Effect pour power users
const stream = uploadMultipart.effect(options)
// Stream<UploadEvent, UploadError, CompressionService | LoggerService>
```

**Rationale :** Progressive disclosure maximale. Effect est la colonne vertébrale interne, jamais une contrainte d'adoption.

---

### Error Handling Architecture

**Décision : `UploadError extends Error` avec `_tag` readonly literal**

Chaque variante étend `Error` (compatibilité écosystème JS : Sentry, loggers, stack traces) et porte un `_tag` readonly literal (compatibilité Effect : `catchTag`, `Match.tag`, exhaustivité TypeScript).

```ts
class PartUploadError extends Error {
  readonly _tag = "PartUploadError" as const
  constructor(
    readonly partNumber: number,
    readonly attempt: number,
    override readonly cause: unknown
  ) {
    super(`Part ${partNumber} failed on attempt ${attempt}`)
    this.name = "PartUploadError"
  }
}

type UploadError =
  | PartUploadError
  | MaxRetriesExceededError
  | PresignedUrlError
  | InitiateUploadError
  | ReconcileError
  | CompleteUploadError
  | AbortError
  | CircuitOpenError
```

**Rationale :** Zéro impact sur la robustesse interne Effect. `instanceof Error` fonctionne côté Promise API. Switch exhaustif `Match.tag` fonctionne côté Effect API. Les deux mondes cohabitent sans couche de conversion.

---

### Module & Package Architecture

**Décision : deux packages npm, exports granulaires, pas de `/core/` dans le chemin**

| Package | Nom npm | Rôle |
|---------|---------|------|
| `packages/core` | `@tranquilload` | Orchestration, streams, services, erreurs |
| `packages/adapters` | `@tranquilload/adapters` | Sources, protocoles, helpers |

**Imports utilisateur :**
```ts
import { uploadMultipart } from "@tranquilload/multipart"
import { uploadOnce }      from "@tranquilload/oneshot"
import { compress }        from "@tranquilload/pipeline"
import { CompressionService } from "@tranquilload/services"

import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload"
import { fromFile }          from "@tranquilload/adapters/fromFile"
import { fromNodeReadable }  from "@tranquilload/adapters/fromNodeReadable"
```

**Exports map `@tranquilload` (`package.json`) :**
```json
{
  "exports": {
    "./multipart":  { "import": "./dist/multipart.js", "require": "./dist/multipart.cjs", "types": "./dist/multipart.d.ts" },
    "./oneshot":    { "import": "./dist/oneshot.js",   "require": "./dist/oneshot.cjs",   "types": "./dist/oneshot.d.ts" },
    "./pipeline":   { "import": "./dist/pipeline.js",  "require": "./dist/pipeline.cjs",  "types": "./dist/pipeline.d.ts" },
    "./services":   { "import": "./dist/services.js",  "require": "./dist/services.cjs",  "types": "./dist/services.d.ts" },
    "./errors":     { "import": "./dist/errors.js",    "require": "./dist/errors.cjs",    "types": "./dist/errors.d.ts" },
    "./progress":   { "import": "./dist/progress.js",  "require": "./dist/progress.cjs",  "types": "./dist/progress.d.ts" }
  }
}
```

**Rationale :** Tree-shaking garanti même sans bundler (scripts Node, CLIs). Cohérent avec le pattern Effect. Le `/core/` supprimé du chemin donne une DX propre.

---

### Infrastructure & Publishing

**Versioning :** indépendant entre `@tranquilload/core` et `@tranquilload/adapters` — chaque package a son propre CHANGELOG. La peer dep `^X.Y.Z` dans adapters couvre les mises à jour minor/patch de core sans rebumper adapters.

**Changesets** pour la gestion des releases :
```bash
pnpm changeset         # décrire un changement (patch/minor/major)
pnpm changeset version # bumper les versions + générer CHANGELOG
pnpm changeset publish # publier sur npm
```

**GitHub Actions — deux workflows :**
- `ci.yml` : sur push/PR → `typecheck + test + build`
- `release.yml` : sur merge `master` → Changesets Action crée PR de release ; merge → publish npm

---

### Decision Impact Analysis

**Implementation Sequence:**
1. Scaffolding monorepo (pnpm workspaces, tsdown, vitest, Turborepo)
2. Définir `errors.ts` — union `UploadError` (base de tout le reste)
3. Implémenter `@tranquilload/multipart` (chemin le plus complexe)
4. Implémenter `@tranquilload/oneshot`
5. Implémenter `@tranquilload/pipeline` (middleware composable)
6. Implémenter `@tranquilload/services` (CompressionService, LoggerService)
7. Implémenter `@tranquilload/adapters/*`
8. CI/CD workflows

**Cross-Component Dependencies:**
- `errors.ts` est importé par tous les modules → à définir en premier
- `services` (CompressionService, LoggerService) sont des dépendances du pipeline et du multipart
- `adapters` dépend de `@tranquilload/core` en `workspace:^` (peerDep) / `workspace:*` (devDep)
- Le Dual API wrapper (Promise ↔ Effect) est dans chaque module entry point, pas centralisé

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

8 zones où des agents IA pourraient faire des choix incompatibles :
Effect Service definition · Dual API wrapper · Callback normalization · AbortSignal interop ·
UploadEvent shape · File naming · Test location · Layer composition

---

### Naming Patterns

**Files & Directories — kebab-case partout :**
```
packages/core/src/
  multipart/
    index.ts          ← entry point du module (Dual API)
    upload-stream.ts  ← logique Effect interne
    chunk-stream.ts
  errors/
    index.ts
    upload-error.ts
  services/
    compression-service.ts
    logger-service.ts
```

**TypeScript :**
- Classes / Types / Interfaces : `PascalCase` (`PartUploadError`, `UploadEvent`)
- Functions / variables : `camelCase` (`uploadMultipart`, `chunkSize`)
- Effect Services : `PascalCase` + suffixe `Service` → `CompressionService`, `LoggerService`
- Effect Layers : `PascalCase` + suffixe `Live` → `CompressionServiceLive`, `LoggerServiceLive`
- Effect Refs : préfixe `ref` → `refProgress`, `refCompletedParts`
- Constantes : `SCREAMING_SNAKE_CASE` → `DEFAULT_CHUNK_SIZE`, `MAX_CONCURRENT_PARTS`

**Tests :** `*.test.ts` co-localisé au fichier testé (pas de dossier `__tests__/` séparé).

---

### Effect Service Definition Pattern

**TOUJOURS** définir les Services avec `Context.Tag` + interface + Layer `Live` dans le même fichier :

```ts
// compression-service.ts

// 1. Interface
export interface CompressionService {
  readonly compress: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>
}

// 2. Tag
export const CompressionService = Context.Tag<CompressionService>("@tranquilload/CompressionService")

// 3. Layer Live (implémentation par défaut)
export const CompressionServiceLive = Layer.succeed(
  CompressionService,
  {
    compress: (stream) => stream.pipeThrough(new globalThis.CompressionStream("deflate-raw"))
  }
)
```

**Anti-pattern :** Séparer Tag, interface et Layer dans des fichiers différents.

---

### Dual API Wrapper Pattern

Chaque module entry point (`index.ts`) expose **systématiquement** les deux surfaces :

```ts
// multipart/index.ts

// Implémentation Effect pure (interne, peut être exportée)
const uploadMultipartEffect = (options: MultipartOptions) =>
  Stream.fromEffect(...) // Stream<UploadEvent, UploadError, CompressionService>

// API publique principale — Promise + ReadableStream
export const uploadMultipart = (options: MultipartOptions) => {
  const program = uploadMultipartEffect(options).pipe(
    Stream.provideLayer(CompressionServiceLive),
    Stream.provideLayer(LoggerServiceLive)
  )
  return {
    events: Stream.toReadableStream(program),
    result: Stream.runLast(program).pipe(Effect.runPromise)
  }
}

// Escape hatch Effect — layers non fournis, l'utilisateur compose
uploadMultipart.effect = uploadMultipartEffect
```

**Règle :** Le wrapper Promise/ReadableStream fournit les Layers par défaut. L'escape hatch `.effect` les laisse ouverts pour composition.

---

### Callback Normalization Pattern

Tout callback utilisateur est normalisé en `Effect` via un helper unique :

```ts
// utils/normalize-callback.ts
export const normalizeCallback = <A, E = never>(
  fn: (() => A) | (() => Promise<A>) | (() => Effect.Effect<A, E>)
): Effect.Effect<A, E | unknown> =>
  Effect.suspend(() => {
    const result = fn()
    if (Effect.isEffect(result)) return result as Effect.Effect<A, E>
    if (result instanceof Promise) return Effect.tryPromise(() => result)
    return Effect.succeed(result as A)
  })
```

**Règle :** Toute fonction utilisateur (`uploadPart`, `completeUpload`, `reconcileCompletedParts`) passe par `normalizeCallback` avant d'être utilisée en interne. Jamais d'appel direct avec `.then()` ou `try/catch`.

---

### AbortSignal Interop Pattern

Conversion `AbortSignal` → `Effect.interrupt` via un pattern standard :

```ts
// utils/abort-interop.ts
export const fromAbortSignal = (signal?: AbortSignal): Effect.Effect<never, AbortError> =>
  Effect.async((resume) => {
    if (!signal) return
    if (signal.aborted) { resume(Effect.fail(new AbortError())); return }
    const handler = () => resume(Effect.fail(new AbortError()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })

// Usage : Effect.raceFirst(uploadPart(...), fromAbortSignal(signal))
```

**Règle :** Jamais de `if (signal.aborted) throw` dans le code Effect. Toujours `Effect.raceFirst` avec `fromAbortSignal`. (`Effect.race` attend le premier *succès* — si `fromAbortSignal` échoue en premier, `Effect.race` attend encore l'upload, ce qui hang. `Effect.raceFirst` retourne le premier à *terminer*, succès ou échec.)

---

### UploadEvent Shape

Union discriminée **exhaustive**, tous les events partagent `timestamp` :

```ts
type UploadEvent =
  | { readonly _tag: "PartCompleted";    readonly partNumber: number; readonly etag: string; readonly bytesUploaded: number; readonly timestamp: number }
  | { readonly _tag: "ProgressTick";     readonly bytesUploaded: number; readonly totalBytes: Option.Option<number>; readonly timestamp: number }
  | { readonly _tag: "UploadCompleted";  readonly uploadId: string; readonly totalParts: number; readonly timestamp: number }
  | { readonly _tag: "CircuitOpen";      readonly failedParts: number; readonly timestamp: number }
```

**Règle :** Tout nouvel event DOIT avoir `_tag` + `timestamp`. Jamais d'event sans discriminant.

---

### Process Patterns

**Effect.Ref — initialisation explicite dans le scope Effect.gen :**
```ts
// ✅ Correct
const program = Effect.gen(function* () {
  const refProgress = yield* Ref.make<Progress>({ bytesUploaded: 0, totalBytes: Option.none() })
})

// ❌ Anti-pattern : Ref comme variable module-level mutable
```

**Error propagation — jamais de `try/catch` dans le code Effect :**
```ts
// ✅ Correct
Effect.tryPromise({ try: () => fetch(url), catch: (e) => new PartUploadError(partNum, attempt, e) })

// ❌ Anti-pattern
try { await fetch(url) } catch(e) { ... }
```

---

### Testing Pattern

Utiliser **`@effect/vitest`** — le package de testing officiel Effect pour Vitest.
Il fournit des helpers (`it.effect`, `it.live`, `layer(...)`) qui évitent le boilerplate `Effect.runPromise` dans chaque test.

```ts
import { it, describe } from "@effect/vitest"

describe("uploadMultipart", () => {
  it.effect("uploads parts in parallel", () =>
    Effect.gen(function* () {
      // test pur Effect, pas de runPromise manuel
    })
  )
})
```

**Dev dependencies à inclure :** `vitest`, `@effect/vitest`.

---

### Reference Documentation

**Documentation Effect locale** — le repo Effect est cloné dans `effect/` à la racine du projet.
Tout agent implémentant ce projet DOIT consulter la doc locale en priorité avant toute recherche web :

- Index général : `effect/docs/index.md`
- README core : `effect/packages/effect/README.md`
- README platform : `effect/packages/platform/README.md`
- README vitest : `effect/packages/vitest/README.md`

---

### Enforcement Guidelines

**Tout agent implémentant ce projet DOIT :**

- Définir Services avec `Context.Tag` + `interface` + `Layer.succeed` dans le même fichier
- Exposer chaque module avec le Dual API wrapper (Promise/ReadableStream + `.effect`)
- Normaliser tout callback utilisateur via `normalizeCallback`
- Utiliser `Effect.raceFirst` + `fromAbortSignal` pour l'interop AbortController
- Utiliser `kebab-case` pour les fichiers, `PascalCase` pour types/classes/services, `camelCase` pour fonctions
- Co-localiser les tests `*.test.ts` au fichier testé
- Utiliser `@effect/vitest` pour tous les tests impliquant Effect
- Consulter `effect/docs/` en priorité pour toute question sur l'API Effect
- Jamais de `try/catch` ou `.then()` dans le code Effect interne

## Project Structure & Boundaries

### Complete Project Directory Structure

```
tranquilload/                         ← racine du monorepo
├── .changeset/
│   └── config.json                   ← config Changesets (versioning indépendant)
├── .github/
│   └── workflows/
│       ├── ci.yml                    ← lint + typecheck + test + build
│       └── release.yml               ← Changesets publish to npm
├── .gitignore
├── package.json                      ← root (private: true, scripts turbo)
├── pnpm-workspace.yaml
├── turbo.json                        ← pipeline: build → test, cache
├── tsconfig.base.json                ← strict + isolatedDeclarations: true
├── README.md
├── effect/                           ← repo Effect cloné (référence doc)
├── smoothmultipartupload/            ← code original de référence
└── packages/
    ├── core/                         ← @tranquilload
    └── adapters/                     ← @tranquilload/adapters
```

**`packages/core/` — `@tranquilload`**

```
packages/core/
├── package.json                      ← name: "@tranquilload", exports map granulaire
├── tsconfig.json                     ← extends ../../tsconfig.base.json
├── tsdown.config.ts
├── src/
│   ├── errors/
│   │   ├── index.ts                  ← re-export
│   │   └── upload-error.ts           ← UploadError union + classes extends Error
│   ├── multipart/
│   │   ├── index.ts                  ← Dual API entry point (export + .effect)
│   │   ├── upload-stream.ts          ← Stream Effect interne, Semaphore, retry
│   │   ├── chunk-stream.ts           ← chunking WHATWG TransformStream → Effect Stream
│   │   └── upload-stream.test.ts
│   ├── oneshot/
│   │   ├── index.ts                  ← Dual API entry point
│   │   ├── upload.ts                 ← Effect interne
│   │   └── upload.test.ts
│   ├── pipeline/
│   │   ├── index.ts                  ← Dual API entry point
│   │   ├── middleware.ts             ← (Stream<Uint8Array>) => Stream<Uint8Array>
│   │   └── middleware.test.ts
│   ├── services/
│   │   ├── index.ts                  ← re-export
│   │   ├── compression-service.ts    ← Tag + interface + CompressionServiceLive
│   │   └── logger-service.ts         ← Tag + interface + LoggerServiceLive (no-op)
│   ├── progress/
│   │   ├── index.ts
│   │   └── upload-event.ts           ← UploadEvent union type
│   └── utils/
│       ├── normalize-callback.ts     ← Promise | throw | Effect → Effect
│       └── abort-interop.ts          ← AbortSignal → Effect.interrupt
└── dist/                             ← généré par tsdown (ESM + CJS + .d.ts)
```

**`packages/adapters/` — `@tranquilload/adapters`**

```
packages/adapters/
├── package.json                      ← name: "@tranquilload/adapters", exports granulaires
├── tsconfig.json
├── tsdown.config.ts
├── src/
│   ├── sources/
│   │   ├── from-file.ts              ← fromFile : File → options enrichies (totalBytes, uploadId, stream)
│   │   ├── from-file.test.ts
│   │   ├── from-node-readable.ts     ← fromNodeReadable : Node Readable → ReadableStream
│   │   └── from-node-readable.test.ts
│   ├── protocols/
│   │   ├── s3-multipart-upload.ts    ← s3MultipartUpload : options S3 (chunk adaptatif, bornes)
│   │   ├── s3-multipart-upload.test.ts
│   │   └── simple-http-upload.ts     ← simpleHttpUpload : PUT/POST one-shot
│   └── resilience/
│       ├── web-locks.ts              ← Web Locks multi-onglets (browser only)
│       └── network-multiplier.ts     ← chunk size dynamique selon throughput mesuré
└── dist/
```

---

### Requirements to Structure Mapping

| Functional Requirement | Location |
|------------------------|----------|
| One-shot upload | `packages/core/src/oneshot/` |
| Multipart upload (orchestration, semaphore, retry) | `packages/core/src/multipart/` |
| Pipeline de transformations | `packages/core/src/pipeline/` |
| Compression (CompressionService) | `packages/core/src/services/compression-service.ts` |
| Observabilité / UploadEvent | `packages/core/src/progress/upload-event.ts` |
| Résumabilité (uploadId, reconcile) | `packages/core/src/multipart/upload-stream.ts` |
| Adapters sources (File, Node) | `packages/adapters/src/sources/` |
| Adapters protocoles (S3, HTTP) | `packages/adapters/src/protocols/` |
| Adapters résilience | `packages/adapters/src/resilience/` |

**Cross-cutting concerns :**

| Concern | Location |
|---------|----------|
| UploadError union | `packages/core/src/errors/upload-error.ts` |
| Callback normalization | `packages/core/src/utils/normalize-callback.ts` |
| AbortSignal interop | `packages/core/src/utils/abort-interop.ts` |
| LoggerService (silence) | `packages/core/src/services/logger-service.ts` |

---

### Architectural Boundaries

**Package boundary — core vs adapters :**
- `@tranquilload` ne connaît ni S3, ni `File` browser, ni Node `Readable`
- `@tranquilload/adapters` dépend de `@tranquilload/core` (`workspace:^` peerDep), jamais l'inverse

**Layer boundary — interne vs externe :**
- API publique (Promise/ReadableStream) : Layers fournis automatiquement
- API `.effect` : Layers ouverts, composables par l'utilisateur

**Runtime boundary :**
- Tout code `packages/core` : `globalThis` uniquement, zéro `window`, zéro `process`
- `from-node-readable.ts` : seul fichier autorisé à importer `node:stream`
- `web-locks.ts` : seul fichier autorisé à utiliser `navigator.locks`

---

### Data Flow

```
User code
  ↓ uploadMultipart(options)           [multipart/index.ts — Dual API wrapper]
  ↓ ChunkStream                        [multipart/chunk-stream.ts]
  ↓ Pipeline middleware (compress...) [pipeline/middleware.ts]
  ↓ UploadStream (Semaphore, retry)    [multipart/upload-stream.ts]
  ↓ normalizeCallback(uploadPart)      [utils/normalize-callback.ts]
  ↓ normalizeCallback(completeUpload)
  ↑ Stream<UploadEvent>                [progress/upload-event.ts]
  ↑ { events: ReadableStream<UploadEvent>, result: Promise<UploadResult> }
```

---

### Development Workflow

```bash
# Dev (watch mode)
pnpm --filter @tranquilload dev        # tsdown --watch

# Build
pnpm turbo build                       # core → adapters (ordre respecté)

# Test
pnpm turbo test                        # vitest sur tous les packages

# Release
pnpm changeset                         # décrire le changement
pnpm changeset version                 # bumper + CHANGELOG
pnpm changeset publish                 # publier sur npm
```

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
- tsdown ESM-first + exports map `import`/`require`/`types` — cohérents
- `isolatedDeclarations: true` requis par tsdown — décidé dans la fondation
- Effect 3.19.19 (latest) + WHATWG Streams API — coexistent nativement
- `@effect/vitest` est un wrapper vitest officiel — pas de conflit
- `UploadError extends Error` + `_tag readonly literal` — compatible Effect `catchTag` et `Match.tag`
- Changesets indépendant — chaque package versioned séparément, peer dep `^` assure la compatibilité

**Pattern Consistency:**
- `Context.Tag` + `interface` + `Layer.Live` dans le même fichier ↔ structure `services/` ✅
- `normalizeCallback` couvre tous les cas du Dual API ✅
- `Effect.raceFirst` + `fromAbortSignal` — pattern isolé, réutilisable partout ✅
- kebab-case fichiers / PascalCase types / camelCase fonctions — standard TypeScript ✅

**Structure Alignment:**
- `errors/` en premier dans la séquence d'implémentation — toutes les dépendances satisfaites ✅
- `@tranquilload/adapters` dépend de `@tranquilload/core` (`workspace:^` peerDep), jamais l'inverse ✅
- `from-node-readable.ts` seul fichier autorisé à importer `node:stream` ✅

---

### Requirements Coverage Validation ✅

| Functional Requirement | Couverture architecturale |
|------------------------|--------------------------|
| One-shot upload | `packages/core/src/oneshot/` |
| Multipart upload | `packages/core/src/multipart/` |
| Pipeline transformations | `packages/core/src/pipeline/` |
| Compression Service | `packages/core/src/services/compression-service.ts` |
| Observabilité / Progress | `packages/core/src/progress/upload-event.ts` + `progress/index.ts` |
| Résilience / Retry | `multipart/upload-stream.ts` (Effect.Schedule injectable) |
| Circuit Breaker (v1) | `packages/core/src/multipart/circuit-breaker.ts` |
| Résumabilité inter-session | `multipart/upload-stream.ts` (uploadId + reconcileCompletedParts) |
| Adapters sources | `packages/adapters/src/sources/` |
| Adapters protocoles | `packages/adapters/src/protocols/` |

**Non-Functional Requirements :**
- Tree-shaking : exports granulaires par sous-chemin ✅
- Bundle minimal : `effect` peer dep (pas bundlé), zéro autre runtime dep dans core ✅
- Runtime agnostique : `globalThis` uniquement, pas d'`engines` restrictif ✅
- Zéro état mutable : `Effect.Ref` pattern documenté ✅
- Silence par défaut : `LoggerServiceLive` no-op ✅
- Adoption sans Effect : `normalizeCallback` + Dual API ✅

---

### Gaps Addressed

**`getProgress()` pull-mode :**
Localisé dans `packages/core/src/progress/index.ts`. Retourne `Effect<Progress>` via lecture d'un `Ref<Progress>` interne passé en paramètre depuis `uploadMultipart`. L'utilisateur y accède via la valeur de retour du Dual API :
```ts
const { events, result, getProgress } = uploadMultipart(options)
// getProgress: () => Promise<Progress>
// getProgress.effect: Effect<Progress>
```

**Effect comme peer dependency :**
`effect >= 3.19.19` est une `peerDependency` dans les deux packages. Raison : le système `Context.Tag` repose sur l'égalité de référence — deux copies d'Effect casseraient silencieusement les Layers pour les utilisateurs de l'escape hatch `.effect`.

**Node.js minimum : aucun.**
Le core ne requiert que `globalThis`. `CompressionStream` est optionnel — si absent, Effect échoue proprement dans le canal d'erreur. Pas d'`engines` restrictif.

**Circuit Breaker — inclus en v1 :**
Localisé dans `packages/core/src/multipart/circuit-breaker.ts`. Machine à 3 états via `Effect.Ref<CircuitState>` :

```
Closed   → (N failures in window T) → Open
Open     → (cooldown elapsed)       → HalfOpen
HalfOpen → (success)                → Closed
HalfOpen → (failure)                → Open
```

```ts
type CircuitState =
  | { _tag: "Closed";   failures: number }
  | { _tag: "Open";     openedAt: number }
  | { _tag: "HalfOpen" }

// Usage dans upload-stream.ts :
// Effect.race(uploadPart(...), circuitBreaker.check())
// circuitBreaker.recordFailure() / circuitBreaker.recordSuccess()
```

Composé avec le retry dans `upload-stream.ts`. Émet `CircuitOpen` event dans `Stream<UploadEvent>` quand le circuit s'ouvre.

---

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Contexte projet analysé (INITIAL_PROMPT + brainstorming)
- [x] Complexité évaluée : Medium, lib npm, 2 packages
- [x] Contraintes techniques identifiées (Effect, WHATWG Streams, globalThis)
- [x] Cross-cutting concerns mappés

**✅ Architectural Decisions**
- [x] API surface : Dual API (Promise/ReadableStream + `.effect`)
- [x] Error surface : `UploadError extends Error` + `_tag`
- [x] Module exports : granulaires, sans `/core/` dans le chemin
- [x] Package naming : `@tranquilload` + `@tranquilload/adapters`
- [x] Versioning : indépendant + Changesets
- [x] CI/CD : GitHub Actions
- [x] Build : tsdown + pnpm workspaces + Turborepo
- [x] Test : vitest + `@effect/vitest`
- [x] Effect version : 3.19.19 (peer dep)

**✅ Implementation Patterns**
- [x] Naming conventions (fichiers, types, services, layers, refs, constantes)
- [x] Effect Service definition pattern (Tag + interface + Layer.Live)
- [x] Dual API wrapper pattern
- [x] Callback normalization pattern
- [x] AbortSignal interop pattern
- [x] UploadEvent shape
- [x] Circuit Breaker state machine
- [x] Testing avec `@effect/vitest`
- [x] Référence doc Effect locale

**✅ Project Structure**
- [x] Arborescence complète définie
- [x] Boundaries package/layer/runtime documentées
- [x] Mapping requirements → fichiers
- [x] Data flow documenté
- [x] Development workflow documenté

---

### Architecture Readiness Assessment

**Overall Status : READY FOR IMPLEMENTATION**

**Confidence Level : High**

**Key Strengths :**
- Architecture Effect-first en interne, transparente en externe — adoption maximale
- Boundaries très nettes (core / adapters, runtime, layers) — agents ne peuvent pas se tromper de couche
- Patterns avec exemples de code concrets — zéro ambiguïté pour l'implémentation
- Circuit Breaker spécifié avec state machine — agent peut implémenter sans design decision supplémentaire
- Doc Effect locale clonée — agents ne dépendent pas de recherches web

**Areas for Future Enhancement (post-v1) :**
- `@tranquilload/background` (Service Worker Background Fetch)
- Download resumable (symétrie avec upload)
- `UploadManager` global (pool partagé multi-uploads)
- Déduplication inflight par `uploadId`

---

### Implementation Handoff

**Tout agent implémentant ce projet doit :**
- Lire ce document en entier avant de commencer
- Consulter `effect/docs/` pour toute question sur l'API Effect
- Suivre les patterns documentés (Service definition, Dual API, normalizeCallback, abort interop)
- Respecter les boundaries (core n'importe jamais depuis adapters, globalThis uniquement dans core)

**Première story d'implémentation :**
Scaffolding monorepo — `pnpm init`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`,
`packages/core/package.json` (avec exports map), `packages/adapters/package.json`, tsdown configs,
`.changeset/config.json`, GitHub Actions workflows.
