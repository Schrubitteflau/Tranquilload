import { Option } from "effect"

export interface UploadInitiated {
  readonly _tag: "UploadInitiated"
  readonly uploadId: string
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
