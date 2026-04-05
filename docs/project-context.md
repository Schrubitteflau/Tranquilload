---
project_name: 'Tranquilload'
user_name: 'Grochonnou'
date: '2026-03-08'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
status: 'complete'
rule_count: 42
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Directory Structure (Critical)

- `packages/tranquilload-core/` — package `@tranquilload/core` (NE PAS nommer `packages/core/` : pnpm crée des symlinks brisés avec les scoped packages)
- `packages/tranquilload-adapters/` — package `@tranquilload/adapters`

Toute référence à `packages/core/` dans les specs est à lire comme `packages/tranquilload-core/`, et `packages/adapters/` comme `packages/tranquilload-adapters/`.

## Technology Stack & Versions

- **TypeScript** — strict mode, `declaration: true` (pas `isolatedDeclarations` — incompatible avec `Context.Tag` d'Effect, TS9021), target ES2022, module NodeNext
- **effect** `3.19.19` — peer dependency dans les deux packages. Ne jamais bundler deux copies : Context.Tag repose sur l'égalité de référence
- **tsdown** — build ESM + CJS + `.d.ts` via Oxc. Sorties : `dist/esm/`, `dist/cjs/`, `dist/types/`. Successeur de tsup (tsup est abandonné, ne pas l'utiliser)
- **pnpm workspaces** — monorepo 2 packages. Référencer core depuis adapters via `workspace:^` (peerDep) et `workspace:*` (devDep)
- **Turborepo** — pipeline `build → test` avec cache. Commande : `pnpm turbo build` / `pnpm turbo test`
- **vitest** + **@effect/vitest** — test runner officiel Effect, évite le boilerplate `Effect.runPromise` dans les tests
- **Changesets** — versioning indépendant des 2 packages (`@tranquilload/core` + `@tranquilload/adapters`) ; peer dep `^X.Y.Z` couvre les mises à jour minor/patch de core sans rebumper adapters
- **WHATWG Streams API** — `ReadableStream`, `TransformStream`, `WritableStream` comme primitives. Disponibles Node 18+, browser, Bun, Deno
- **Documentation Effect locale** — repo cloné dans `effect/` à la racine. Toujours consulter `effect/docs/` en priorité avant toute recherche web

## Critical Implementation Rules

### Language-Specific Rules

**TypeScript :**
- `declaration: true` dans `tsconfig.base.json` — `isolatedDeclarations` est retiré (incompatible avec `Context.Tag`). Les annotations de type explicites sur les exports publics sont une bonne pratique mais l'inférence est permise
- Pas de `any` — le canal d'erreur Effect est typé, les erreurs sont une union fermée exhaustive
- `globalThis` uniquement dans `packages/core` — jamais `window`, jamais `process`

**Effect — règles internes :**
- Jamais de `try/catch` dans le code Effect — utiliser `Effect.tryPromise({ try, catch })` ou `Effect.try({ try, catch })`
- Jamais de `.then()` dans le code Effect — tout callback utilisateur passe par `normalizeCallback`
- Les `Effect.Ref` sont initialisés dans le scope `Effect.gen`, jamais comme variable de module
- `Effect.raceFirst` + `fromAbortSignal` pour l'interop AbortController — jamais de `if (signal.aborted) throw`. (`Effect.race` = premier succès ; `Effect.raceFirst` = premier achèvement — c'est `raceFirst` qu'il faut)

**Dual API wrapper — FiberFailure wrapping :**
- `Effect.runPromise` rejette avec un `FiberFailure` qui wrape l'erreur typée — PAS l'erreur brute. Le consommateur Promise recevrait `FiberFailure` au lieu de `AbortError`
- Solution : `Effect.runPromiseExit` + `Cause.squash` pour extraire l'erreur brute :
  ```ts
  const collected = Stream.runCollect(program).pipe(
    Effect.map((chunk) => Array.from(chunk)),
    Effect.runPromiseExit
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })
  ```
- Ce pattern DOIT être utilisé dans tous les Dual API wrappers (`index.ts`) — jamais `Effect.runPromise` directement

**Erreurs :**
- Chaque variante de `UploadError` extends `Error` ET a un `readonly _tag` literal
- L'union `UploadError` est fermée — utiliser `Match.tag` ou `switch` exhaustif sur `_tag`
- Constructeur : `super(message)` + `this.name = "NomDeLErreur"` dans chaque classe

**Imports :**
- Exports granulaires via sous-chemins : `@tranquilload/core/multipart`, `@tranquilload/core/oneshot`, etc. — jamais `@tranquilload/core` seul
- `@tranquilload/adapters` dépend de `@tranquilload/core` via `workspace:^` (peerDep) / `workspace:*` (devDep) — jamais l'inverse
- `from-node-readable.ts` est le seul fichier autorisé à importer `node:stream`
- `web-locks.ts` est le seul fichier autorisé à utiliser `navigator.locks`

### Framework-Specific Rules

**Effect Service Definition (pattern obligatoire) :**
- Interface + Tag + Layer `Live` dans le **même fichier** — jamais séparés
- Tag : `Context.Tag<ServiceInterface>("@tranquilload/ServiceName")`
- Layer : `Layer.succeed(ServiceTag, { ...implementation })`
- Nommage : `CompressionService` (interface + tag), `CompressionServiceLive` (layer)

**Dual API (chaque module entry point `index.ts`) :**
- API publique : retourne `{ result: Promise<UploadResult>, events: ReadableStream<UploadEvent> }`
- Les Layers par défaut (`CompressionServiceLive`, `LoggerServiceLive`) sont fournis automatiquement dans l'API publique
- Escape hatch : `uploadMultipart.effect` retourne le `Stream` brut avec Layers ouverts pour composition utilisateur
- Le wrapper Promise/ReadableStream est dans `index.ts`, la logique Effect pure dans un fichier séparé (`upload-stream.ts`, `upload.ts`, etc.)

**Callback normalization (règle absolue) :**
- Tout callback utilisateur (`uploadPart`, `completeUpload`, `reconcileCompletedParts`) passe par `normalizeCallback` avant usage interne
- `normalizeCallback` accepte `() => A`, `() => Promise<A>`, `() => Effect<A, E>` — détecte automatiquement

**Layer composition :**
- L'API publique : `Stream.provideLayer(CompressionServiceLive)` puis `Stream.provideLayer(LoggerServiceLive)`
- L'escape hatch `.effect` : Layers ouverts, l'utilisateur compose lui-même
- `effect` doit être une seule instance partagée — deux copies cassent silencieusement `Context.Tag`

**UploadEvent :**
- Tout nouvel event DOIT avoir `_tag` (literal) + `timestamp` (number)
- `Option.Option<number>` pour `totalBytes` (pas `number | undefined`)

### Testing Rules

**Organisation :**
- Tests co-localisés avec le fichier source : `upload-stream.test.ts` à côté de `upload-stream.ts`
- Jamais de dossier `__tests__/` séparé
- Nommage : `*.test.ts` (pas `*.spec.ts`)

**@effect/vitest (obligatoire pour tout code Effect) :**
- Importer `{ it, describe }` depuis `@effect/vitest`, pas depuis `vitest`
- Utiliser `it.effect(...)` pour les tests Effect purs — pas de `Effect.runPromise` manuel dans les tests
- Utiliser `it.live(...)` pour les tests nécessitant des effets réels (réseau, filesystem)

**TestClock pour les Schedules time-based :**
- `Schedule.exponential` et tout Schedule avec delays réels nécessitent `Effect.fork` + `TestClock.adjust("Xms")` pour avancer le temps virtuel dans les tests — sans ça, le test attend de vraies millisecondes
- `Schedule.recurs` (aucun délai) fonctionne sans `TestClock`
- Pattern : `const fiber = yield* Effect.fork(myEffect)` puis `yield* TestClock.adjust("500 millis")` puis `yield* Fiber.join(fiber)`

**`normalizeCallback` et le double-wrapping d'erreurs :**
- `normalizeCallback` + `mapError` dans `upload-stream.ts` : quand un callback de type `Effect` est passé à `uploadPart`, les erreurs sont double-wrappées (une fois par `normalizeCallback`, une fois par `mapError`)
- Dans les tests, utiliser un callback `throw` ou `Promise.reject` pour simuler fidèlement le scenario réel et éviter le double-wrapping
- Les callbacks Effect sont supportés via `normalizeCallback` mais les erreurs émises sont toujours wrappées en `PartUploadError` avant d'atteindre `Effect.retry`

**`Ref.update` et timing post-`uploadPart` :**
- `Ref.update` fire **après** que `uploadPart` resolves — un `getProgress()` pollé **à l'intérieur** du callback `uploadPart` pour la **part 1** verra 0 bytes (le Ref n'a pas encore été mis à jour)
- Pour observer une progression > 0 dans les tests, poller `getProgress()` sur la **part 2** minimum
- Contexte : `uploadMultipartEffect` met à jour `refProgress` après le retour du callback `uploadPart`, pas pendant

**Layers dans les tests :**
- Injecter des Layers de test via `layer(TestLayer)` helper de `@effect/vitest`
- Ne jamais utiliser `CompressionServiceLive` dans les tests — injecter un no-op ou un mock

**Ce qu'il faut tester :**
- Chaque module interne Effect (ex: `upload-stream.ts`) a ses propres tests isolés
- Le Dual API wrapper (`index.ts`) est testé via l'API Promise/ReadableStream publique
- `normalizeCallback` et `fromAbortSignal` ont leurs propres tests unitaires

**Commande :**
- `pnpm turbo test` — exécute vitest sur tous les packages dans l'ordre du pipeline

### Code Quality & Style Rules

**Nommage (règles strictes) :**
- Fichiers & dossiers : `kebab-case` — `upload-stream.ts`, `compression-service.ts`
- Classes / Types / Interfaces : `PascalCase` — `PartUploadError`, `UploadEvent`
- Fonctions / variables : `camelCase` — `uploadMultipart`, `chunkSize`
- Effect Services : `PascalCase` + suffixe `Service` — `CompressionService`, `LoggerService`
- Effect Layers : `PascalCase` + suffixe `Live` — `CompressionServiceLive`, `LoggerServiceLive`
- Effect Refs : préfixe `ref` — `refProgress`, `refCompletedParts`
- Constantes : `SCREAMING_SNAKE_CASE` — `DEFAULT_CHUNK_SIZE`, `MAX_CONCURRENT_PARTS`

**Organisation des fichiers :**
- `index.ts` = entry point Dual API uniquement (wrapper Promise/ReadableStream + `.effect`)
- Logique Effect pure = fichier dédié (`upload-stream.ts`, `upload.ts`, `middleware.ts`)
- Utilitaires cross-cutting = `src/utils/` (`normalize-callback.ts`, `abort-interop.ts`)
- Re-exports = `index.ts` dans les dossiers (`services/index.ts`, `errors/index.ts`)

**Taille et portée :**
- Un fichier = une responsabilité. `compression-service.ts` ne contient que `CompressionService`
- Pas d'abstraction prématurée — trois lignes similaires valent mieux qu'une abstraction forcée
- Pas de commentaires sauf si la logique n'est pas auto-évidente

### Development Workflow Rules

**Build & dev :**
- `pnpm turbo build` — build complet (core avant adapters, ordre automatique)
- `pnpm --filter @tranquilload dev` — watch mode tsdown sur core
- `pnpm turbo test` — tests tous packages avec cache Turborepo

**Releases avec Changesets :**
- `pnpm changeset` — décrire un changement (patch/minor/major) avant de committer
- `pnpm changeset version` — bumper les versions + générer CHANGELOG (dans la "Version Packages" PR)
- `pnpm changeset publish` — publier sur npm (géré par GitHub Actions `release.yml`)
- Versioning **indépendant** : `@tranquilload/core` et `@tranquilload/adapters` peuvent évoluer séparément ; seul un major bump de core requiert une mise à jour de la peer dep dans adapters

**CI/CD (GitHub Actions) :**
- `ci.yml` : typecheck + test + build sur chaque push/PR — doit passer avant merge
- `release.yml` : déclenché sur merge `main` — Changesets Action crée une PR de release ; son merge publie sur npm
- Turborepo cache actif en CI — les packages non modifiés sont skippés

**Ordre d'implémentation :**
1. `errors/` en premier (tous les modules en dépendent)
2. `services/` (CompressionService, LoggerService)
3. `utils/` (normalizeCallback, fromAbortSignal)
4. Modules core (`multipart/`, `oneshot/`, `pipeline/`, `progress/`)
5. `adapters/` (dépend de core via `workspace:^` peerDep / `workspace:*` devDep)

### Critical Don't-Miss Rules

**Anti-patterns absolus :**
- ❌ `try/catch` ou `.then()` dans du code Effect interne — toujours `Effect.tryPromise` / `Effect.try`
- ❌ Appeler un callback utilisateur directement — toujours via `normalizeCallback`
- ❌ `if (signal.aborted) throw` — toujours `Effect.raceFirst(uploadEffect, fromAbortSignal(signal))` (pas `Effect.race` : attend le premier succès, pas le premier achèvement)
- ❌ `Effect.Ref` comme variable de module — toujours initialisé dans `Effect.gen`
- ❌ `import { something } from "node:stream"` hors de `from-node-readable.ts`
- ❌ `window.xxx` ou `process.xxx` dans `packages/core` — uniquement `globalThis`
- ❌ Importer `@tranquilload` depuis `packages/core` lui-même — boundary circulaire
- ❌ Bundler `effect` dans le dist — c'est une `peerDependency`, ne jamais l'inclure dans les sorties
- ❌ `import { it } from "vitest"` dans un test Effect — utiliser `@effect/vitest`
- ❌ Séparer Tag, interface et Layer dans des fichiers différents pour un Service

**Boundaries runtime (violations silencieuses) :**
- Deux copies d'`effect` dans le même runtime → `Context.Tag` casse silencieusement (les Layers ne se connectent plus)
- `CompressionStream` absent → doit échouer dans le canal d'erreur Effect, pas lancer une exception non typée

**Edge cases à toujours gérer :**
- `totalBytes` inconnu au moment du démarrage → `Option.none()`, jamais `undefined`
- `reconcileCompletedParts` absent → comportement identique à un upload frais (pas de branche spéciale)
- Pipeline vide (zéro transforms) → stream passe sans modification, pas d'erreur

**Référence doc :**
- Consulter `effect/docs/index.md` avant toute question sur l'API Effect
- `effect/packages/vitest/README.md` pour `@effect/vitest`
- Ne jamais utiliser tsup — il est abandonné, utiliser tsdown

---

## Reference Documents

When implementing stories, consult these documents in order of priority:

1. **`_bmad-output/planning-artifacts/architecture.md`** — source of truth for all implementation decisions: patterns with code examples, full directory structure, boundaries, data flow, and enforcement guidelines. Read before implementing any module.
2. **`_bmad-output/planning-artifacts/epics.md`** — epic and story breakdown with acceptance criteria. Read the relevant story before implementing it.
3. **`_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md`** — design rationale and explored alternatives. Consult only if a decision in architecture.md is unclear or seems incomplete.

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Consult `effect/docs/index.md` for any Effect API question before searching the web
- Update this file if new patterns emerge during implementation

**For Humans:**
- Keep this file lean and focused on agent needs
- Update when technology stack or patterns change
- Remove rules that become obvious over time

Last Updated: 2026-04-05
