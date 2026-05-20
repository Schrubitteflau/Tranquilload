export interface ReadmeBlock {
  /** Most recent heading at any level when the block opens. */
  heading: string
  /** Language tag from the fence (e.g. "ts", "bash"); "" if untagged. */
  lang: string
  /** Code body, with trailing newline stripped. */
  code: string
  /** 1-based line number where the opening fence sits — used for error messages. */
  startLine: number
}

const FENCE_RE = /^(`{3,})\s*([A-Za-z0-9_+\-]*)\s*$/
const HEADING_RE = /^#{1,6}\s+(.*\S)\s*$/

export function extractReadmeBlocks(markdown: string): ReadonlyArray<ReadmeBlock> {
  const lines = markdown.split(/\r?\n/)
  const blocks: ReadmeBlock[] = []
  let heading = ""
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      heading = headingMatch[1] ?? ""
      i++
      continue
    }
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? ""
      const lang = fenceMatch[2] ?? ""
      const startLine = i + 1
      const buf: string[] = []
      i++
      while (i < lines.length) {
        const inner = lines[i] ?? ""
        if (inner.startsWith(fence) && /^`+\s*$/.test(inner)) {
          break
        }
        buf.push(inner)
        i++
      }
      blocks.push({ heading, lang, code: buf.join("\n"), startLine })
      i++
      continue
    }
    i++
  }
  return blocks
}

export function findBlock(
  blocks: ReadonlyArray<ReadmeBlock>,
  predicate: (block: ReadmeBlock) => boolean,
  context: string,
): ReadmeBlock {
  const found = blocks.find(predicate)
  if (!found) {
    throw new Error(
      `Doctest extractor: no README block matched (${context}). ` +
        `Has the heading been renamed? Update the predicate in the test.`,
    )
  }
  return found
}
