import fs from "fs/promises"
import { getTemplateAbsolutePath } from "@/lib/docx/renderFromTemplate"

function toPublicTemplatePath(templatePath: string): string {
  const normalized = templatePath.replace(/\\/g, "/").replace(/^\/+/, "")
  return normalized.startsWith("templates/") ? `/${normalized}` : `/templates/${normalized}`
}

export async function loadTemplateBuffer(templatePath: string, requestOrigin?: string): Promise<Buffer> {
  try {
    const absoluteTemplatePath = getTemplateAbsolutePath(templatePath)
    return await fs.readFile(absoluteTemplatePath)
  } catch (localErr) {
    if (!requestOrigin) {
      throw localErr
    }

    const publicPath = toPublicTemplatePath(templatePath)
    const templateUrl = new URL(publicPath, requestOrigin).toString()
    const response = await fetch(templateUrl, { cache: "no-store" })
    if (!response.ok) {
      throw new Error(
        `Template unavailable locally and via ${templateUrl} (HTTP ${response.status} ${response.statusText}). Local error: ${String(localErr)}`
      )
    }

    return Buffer.from(await response.arrayBuffer())
  }
}
