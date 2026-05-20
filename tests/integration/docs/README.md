# Doctest harness (Story 10.6)

Machine-checks every TypeScript code block in the project's `README.md` so
documentation stays in sync with the published API.

Three tests, all defined in `doctest.test.ts`:

| Test ID       | README section          | What it does                                                                                |
|---------------|-------------------------|---------------------------------------------------------------------------------------------|
| `10.6-D-001`  | _One-shot upload_       | Compile against the published `.d.mts` + run against a mocked `fetch`. Asserts body bytes. |
| `10.6-D-002`  | _Multipart upload to S3_ | Compile against the published `.d.mts` + run against MinIO. Asserts `HeadObject`/`GetObject`. |
| `10.6-D-003`  | _Errors are data_       | **Compile-only.** Adding a new `UploadError` variant without updating the README block fails `tsc` (`Match.exhaustive`). |

## How it works

1. `extract-readme-blocks.ts` parses `README.md` and returns every fenced code
   block with its preceding heading.
2. Each test looks up the relevant block by heading prefix.
3. The block is **wrapped**: its `import` statements stay at the top, its body
   moves into an `export async function run({ ... })` that receives the bindings
   the block uses as free variables (`file`, `s3Client`, `localStorage`). The
   wrapped source is written into the DIST fixture from `tests/integration/global-setup.ts`,
   which has `@tranquilload/core` and `@tranquilload/adapters` installed via
   `pnpm pack` + `npm install`. This is the same fixture that Story 10.5 uses.
4. The fixture's local `tsc` compiles the wrapped block against the published
   `.d.mts` types — type errors fail the test.
5. For the two runnable tests, the emitted `.mjs` is dynamically imported and
   `run(env)` is invoked with the appropriate mocks.

## Adding or updating a doctest

- **Renaming or removing a README heading:** update the heading prefix in
  `findBlock(...)` to keep the test pointing at the right block.
- **New runnable example:** add an `it("10.6-D-NNN — ...", ...)` block, pick a
  `WrapSpec.id`, list the bindings the example uses as `paramSignature`, and
  inject mocks for any browser-only API the block touches (`fetch`,
  `localStorage`, etc).
- **New compile-only example:** set `executable: false` and use `prelude` for
  ambient declarations the block expects to find in scope.

The current `splitImports` helper only understands **single-line `import`
statements**. If the README ever needs multi-line imports
(`import {\n  foo,\n} from "bar"`), `splitImports` must learn to recognize the
terminator.

## Running

```bash
# Local — MinIO is optional; 10.6-D-002 skips if it's not up.
pnpm --filter @tranquilload/tests test:integration

# Force MinIO requirement (CI, nightly):
MINIO_REQUIRED=1 pnpm --filter @tranquilload/tests test:integration
```

The DIST fixture is built once per vitest invocation by the shared
`global-setup.ts` — running just `doctest.test.ts` still triggers a full
`pnpm turbo build` + `pnpm pack` + `npm install` cycle. Set
`DIST_SKIP_BUILD=1` if you've just built and want to skip the rebuild.
