export type Transform = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>

export const compose = (...transforms: Transform[]): Transform =>
  (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
    transforms.reduce((s, t) => t(s), stream)
