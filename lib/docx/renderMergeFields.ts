import PizZip from "pizzip"

const MERGE_FIELD_BLOCK_REGEX =
  /(<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>)([\s\S]*?<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="separate"[^>]*\/>)([\s\S]*?)(<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>)/g
const MERGE_FIELD_NAME_REGEX = /MERGEFIELD\s+(?:"([^"]+)"|([^\s\\]+))/i
const TEXT_RUN_REGEX = /(<w:t(?:\s+[^>]*)?>)([\s\S]*?)(<\/w:t>)/g

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

const normalizeMergeFieldValue = (value: unknown) => {
  if (value === null || value === undefined) return ""
  return String(value)
}

const normalizeBraceTokenName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

function buildBraceTokenLookup(mergeFields: Record<string, unknown>) {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries(mergeFields)) {
    normalized.set(normalizeBraceTokenName(key), value)
  }
  return normalized
}

function resolveBraceTokenValue(
  rawFieldName: string,
  mergeFields: Record<string, unknown>,
  braceLookup: Map<string, unknown>
) {
  const fieldName = rawFieldName.trim()
  if (!fieldName) return null

  if (fieldName in mergeFields) {
    return normalizeMergeFieldValue(mergeFields[fieldName])
  }

  const normalizedMatch = braceLookup.get(normalizeBraceTokenName(fieldName))
  if (normalizedMatch === undefined) return null
  return normalizeMergeFieldValue(normalizedMatch)
}

function extractMergeFieldName(instructionAndSeparate: string): string | null {
  const fieldMatch = MERGE_FIELD_NAME_REGEX.exec(instructionAndSeparate)
  if (!fieldMatch) return null
  const fieldName = (fieldMatch[1] ?? fieldMatch[2] ?? "").trim()
  return fieldName || null
}

function resolveMergeFieldValue(
  rawFieldName: string,
  mergeFields: Record<string, unknown>,
  mergeFieldLookup: Map<string, unknown>
) {
  if (rawFieldName in mergeFields) {
    return normalizeMergeFieldValue(mergeFields[rawFieldName])
  }

  const normalizedMatch = mergeFieldLookup.get(normalizeBraceTokenName(rawFieldName))
  if (normalizedMatch === undefined) return ""
  return normalizeMergeFieldValue(normalizedMatch)
}

function replaceFieldResultRuns(segment: string, value: string) {
  const escapedValue = escapeXml(value)
  const needsPreserve = value.length > 0 && (value.startsWith(" ") || value.endsWith(" "))
  const replacementText = `<w:t${needsPreserve ? ' xml:space="preserve"' : ""}>${escapedValue}</w:t>`

  let inserted = false
  const replaced = segment.replace(/<w:t(?:\s+[^>]*)?>[\s\S]*?<\/w:t>/g, () => {
    if (inserted) return "<w:t></w:t>"
    inserted = true
    return replacementText
  })

  if (inserted) return replaced
  return `${segment}<w:r>${replacementText}</w:r>`
}

function replaceMergeFieldsInXml(xml: string, mergeFields: Record<string, unknown>) {
  const mergeFieldLookup = buildBraceTokenLookup(mergeFields)

  return xml.replace(
    MERGE_FIELD_BLOCK_REGEX,
    (_match, begin, instructionAndSeparate, resultSegment, end) => {
      const fieldName = extractMergeFieldName(instructionAndSeparate)
      if (!fieldName) return `${begin}${instructionAndSeparate}${resultSegment}${end}`

      const replacementValue = resolveMergeFieldValue(fieldName, mergeFields, mergeFieldLookup)
      const updatedResultSegment = replaceFieldResultRuns(resultSegment, replacementValue)
      return `${begin}${instructionAndSeparate}${updatedResultSegment}${end}`
    }
  )
}

function replaceBraceTokensInXml(xml: string, mergeFields: Record<string, unknown>) {
  const braceLookup = buildBraceTokenLookup(mergeFields)
  const runRegex = new RegExp(TEXT_RUN_REGEX.source, "g")
  const runs: Array<{ start: number; end: number; openTag: string; text: string; closeTag: string }> = []

  let match: RegExpExecArray | null
  while ((match = runRegex.exec(xml)) !== null) {
    runs.push({
      start: match.index,
      end: runRegex.lastIndex,
      openTag: match[1],
      text: match[2],
      closeTag: match[3],
    })
  }

  if (runs.length === 0) return xml

  const updatedTexts = runs.map((run) => run.text)

  for (let i = 0; i < updatedTexts.length; i++) {
    let searchFrom = 0

    while (true) {
      const openBraceIndex = updatedTexts[i].indexOf("{", searchFrom)
      if (openBraceIndex < 0) break

      let endRunIndex = i
      let closeBraceIndex = updatedTexts[i].indexOf("}", openBraceIndex + 1)
      let rawFieldName = ""

      if (closeBraceIndex >= 0) {
        rawFieldName = updatedTexts[i].slice(openBraceIndex + 1, closeBraceIndex)
      } else {
        rawFieldName = updatedTexts[i].slice(openBraceIndex + 1)
        while (endRunIndex + 1 < updatedTexts.length) {
          endRunIndex += 1
          const nextClose = updatedTexts[endRunIndex].indexOf("}")
          if (nextClose >= 0) {
            rawFieldName += updatedTexts[endRunIndex].slice(0, nextClose)
            closeBraceIndex = nextClose
            break
          }
          rawFieldName += updatedTexts[endRunIndex]
        }
      }

      if (closeBraceIndex < 0) {
        searchFrom = openBraceIndex + 1
        continue
      }

      const resolvedValue = resolveBraceTokenValue(rawFieldName, mergeFields, braceLookup)
      if (resolvedValue === null) {
        searchFrom = openBraceIndex + 1
        continue
      }

      const escapedReplacement = escapeXml(resolvedValue)
      if (endRunIndex === i) {
        const before = updatedTexts[i].slice(0, openBraceIndex)
        const after = updatedTexts[i].slice(closeBraceIndex + 1)
        updatedTexts[i] = `${before}${escapedReplacement}${after}`
        searchFrom = before.length + escapedReplacement.length
        continue
      }

      const before = updatedTexts[i].slice(0, openBraceIndex)
      updatedTexts[i] = `${before}${escapedReplacement}`

      for (let k = i + 1; k < endRunIndex; k++) {
        updatedTexts[k] = ""
      }

      updatedTexts[endRunIndex] = updatedTexts[endRunIndex].slice(closeBraceIndex + 1)
      searchFrom = updatedTexts[i].length
    }
  }

  let updatedXml = xml
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    const replacement = `${run.openTag}${updatedTexts[i]}${run.closeTag}`
    updatedXml = `${updatedXml.slice(0, run.start)}${replacement}${updatedXml.slice(run.end)}`
  }

  return updatedXml
}

export function renderMergeFieldsTemplateBuffer(
  templateBuffer: Buffer,
  mergeFields: Record<string, unknown>
): Buffer {
  const zip = new PizZip(templateBuffer.toString("binary"))
  const entries = Object.entries(zip.files)

  for (const [filePath, zipObject] of entries) {
    if (zipObject.dir) continue
    if (!filePath.startsWith("word/") || !filePath.endsWith(".xml")) continue

    const xml = zipObject.asText()
    const updatedXml = replaceBraceTokensInXml(replaceMergeFieldsInXml(xml, mergeFields), mergeFields)
    if (updatedXml !== xml) {
      zip.file(filePath, updatedXml)
    }
  }

  return zip.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  })
}

export default {
  renderMergeFieldsTemplateBuffer,
}
