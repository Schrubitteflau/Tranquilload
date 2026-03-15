import { Option } from "effect"

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

export type UploadEvent = UploadCompleted | PartCompleted | ProgressTick | CircuitOpen
