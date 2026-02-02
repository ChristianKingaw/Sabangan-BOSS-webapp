import { PDFDocument } from 'pdf-lib'

export async function mergePdfUrls(urls: string[]): Promise<Blob> {
  const mergedPdf = await PDFDocument.create()

  for (const url of urls) {
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`Failed to fetch PDF at ${url}`)
    }
    const arrayBuffer = await resp.arrayBuffer()
    const src = await PDFDocument.load(arrayBuffer)
    const copied = await mergedPdf.copyPages(src, src.getPageIndices())
    copied.forEach((p) => mergedPdf.addPage(p))
  }

  const mergedBytes = await mergedPdf.save()
  return new Blob([mergedBytes.buffer as ArrayBuffer], { type: 'application/pdf' })
}
