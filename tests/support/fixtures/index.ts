import { mergeTests } from "@playwright/test"
import { test as minioTest } from "./minio.fixture.js"
import { test as testAppTest } from "./test-app.fixture.js"
import { test as uploadFileTest } from "./upload-file.fixture.js"

/**
 * Composed Playwright `test` for Tranquilload E2E.
 *
 * Includes:
 *   - MinIO worker client + per-test purgeUploads helper      (minio.fixture)
 *   - Test-app pre-navigated page with cleared localStorage    (test-app.fixture)
 *   - Deterministic file-bytes factory                         (upload-file.fixture)
 *
 * Usage in PW-UI specs:
 *   import { test, expect } from "@support/fixtures"
 *
 * PW-Lib specs that only need a browser realm (no test-app UI) can import
 * directly from `@playwright/test` instead.
 */
export const test = mergeTests(minioTest, testAppTest, uploadFileTest)
export { expect } from "@playwright/test"
