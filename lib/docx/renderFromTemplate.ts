import Docxtemplater from "docxtemplater"
import PizZip from "pizzip"
import fs from "fs"
import path from "path"

/**
 * Render a DOCX file from a template with the provided data.
 * This must run on the server (Node runtime).
 *
 * @param templatePath - Relative path to the template file from the project root
 * @param data - Object containing the data to inject into the template
 * @returns Buffer of the rendered DOCX file
 */
export function renderFromTemplate(
  templatePath: string,
  data: Record<string, unknown>
): Buffer {
  // Resolve the template path from the available runtime roots
  const absolutePath = getTemplateAbsolutePath(templatePath)
  const templateBuffer = fs.readFileSync(absolutePath)

  return renderFromTemplateBuffer(templateBuffer, data)
}

export function renderFromTemplateBuffer(
  templateBuffer: Buffer,
  data: Record<string, unknown>
): Buffer {
  // Read template content as binary string for PizZip/docxtemplater
  const templateContent = templateBuffer.toString("binary")

  // Create a PizZip instance with the template content
  const zip = new PizZip(templateContent)

  // Create a Docxtemplater instance configured for template loops and line breaks
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  })

  // Render the document with provided data
  doc.render(data)

  // Generate the output as a buffer
  const outputBuffer = doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  })

  return outputBuffer
}

export function getTemplateAbsolutePath(templatePath: string): string {
  const normalizedTemplatePath = templatePath.replace(/\\/g, "/")

  const candidateRoots = [
    process.cwd(),
    path.resolve(process.cwd(), "."),
    path.resolve(__dirname, "..", ".."), // repo root when executed from lib/docx
    path.resolve(__dirname, "..", "..", ".."),
    "/workspace",
  ]

  const uniqueCandidates = Array.from(
    new Set(candidateRoots.map((root) => path.resolve(root, normalizedTemplatePath)))
  )

  const match = uniqueCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })

  if (!match) {
    throw new Error(
      `Template not found: ${templatePath}. Checked: ${uniqueCandidates.join(", ")}`
    )
  }

  return match
}
