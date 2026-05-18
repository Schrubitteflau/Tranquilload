import { test as base } from "@playwright/test"
import type { S3Client } from "@aws-sdk/client-s3"
import {
  loadMinioEnv,
  makeMinioClient,
  purgeUploadsPrefix,
  type MinioEnv,
} from "../helpers/minio-client.js"

export interface MinioFixtures {
  /**
   * Worker-scoped MinIO client. Reused across tests in the same worker for speed.
   * Tests that need a clean bucket must call `purgeUploads()` explicitly.
   */
  minio: { client: S3Client; env: MinioEnv }
  /** Test-scoped purge helper bound to the worker's MinIO client. */
  purgeUploads: () => Promise<number>
}

export const test = base.extend<MinioFixtures, { minioWorker: MinioFixtures["minio"] }>({
  minioWorker: [
    async ({}, use) => {
      const env = loadMinioEnv()
      const client = makeMinioClient(env)
      await use({ client, env })
      client.destroy()
    },
    { scope: "worker" },
  ],

  minio: async ({ minioWorker }, use) => {
    await use(minioWorker)
  },

  purgeUploads: async ({ minio }, use) => {
    await use(() => purgeUploadsPrefix(minio.client, minio.env.bucket))
  },
})

export { expect } from "@playwright/test"
