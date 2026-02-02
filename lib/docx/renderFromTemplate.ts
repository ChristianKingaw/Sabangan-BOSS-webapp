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
  // Resolve the template path relative to the project root
  const absolutePath = path.resolve(process.cwd(), templatePath)

  // Read the template file as binary
  const templateContent = fs.readFileSync(absolutePath, "binary")

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
