import { Option } from "effect"

export interface UploadInitiated {
  readonly _tag: "UploadInitiated"
  readonly uploadId: string
  /**
   * Populated when `getContentDigest` was provided on the fresh-init path.
   * Carried on the event so the public wrapper can build a complete `ResumeState`
   * without needing access to the internal digest Ref.
   */
  readonly contentDigest?: string
  readonly timestamp: number
}

export interface UploadCompleted {
  readonly _tag: "UploadCompleted"
  readonly uploadId: string
  readonly totalParts: number
  readonly timestamp: number
}

export interface PartCompleted {
  readonly _tag: "PartCompleted"
  readonly partNumber: number
  readonly etag: string
  readonly bytesUploaded: number
  readonly timestamp: number
}

export interface CircuitOpen {
  readonly _tag: "CircuitOpen"
  readonly failedParts: number
  readonly timestamp: number
}

export interface ProgressTick {
  readonly _tag: "ProgressTick"
  readonly bytesUploaded: number
  readonly totalBytes: Option.Option<number>
  readonly timestamp: number
}

export type UploadEvent = UploadInitiated | UploadCompleted | PartCompleted | ProgressTick | CircuitOpen
