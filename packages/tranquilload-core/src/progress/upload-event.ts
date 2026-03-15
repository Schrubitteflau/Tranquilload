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

// Minimal type — Story 5.1 will expand to full discriminated union
export type UploadEvent = UploadCompleted | PartCompleted
