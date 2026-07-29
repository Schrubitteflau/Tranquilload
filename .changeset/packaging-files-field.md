---
"@tranquilload/core": patch
"@tranquilload/adapters": patch
---

Ship only what consumers need: the published tarball is now `dist/` + `CHANGELOG.md` + `package.json`, declared explicitly via a `files` field.

Until now neither package declared `files`, so tarball contents were decided by whatever the packer chose to keep. Every release carried the full `src/` tree (unit tests included), `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts` and even a stray `.turbo/turbo-build.log`. Install size drops accordingly.

**Nothing is lost for consumers.** The `.mjs.map` / `.cjs.map` files embed complete `sourcesContent`, so stepping into library source in a debugger still works without `src/` being shipped. No API change, no behaviour change — the runtime bytes under `dist/` are identical.

This also removes a real hazard: because `dist/` is gitignored and the packer follows the ignore file in recent toolchains, an undeclared `files` field meant the published tarball could silently lose `dist/` entirely — every export map entry pointing at a file absent from the package. Declaring `files` makes the published surface intentional rather than a side effect of `.gitignore`.
