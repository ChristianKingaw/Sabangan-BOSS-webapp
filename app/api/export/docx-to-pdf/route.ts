import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { adminAuth, adminDb } from "@/lib/firebase-admin"
import { renderFromTemplate } from "@/lib/docx/renderFromTemplate"
import fs from "fs"
import os from "os"
import path from "path"
import { mapApplicationToTemplate } from "@/lib/export/mapApplicationToTemplate"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"
import { spawn } from "child_process"
import { PDFDocument } from "pdf-lib"

export const runtime = "nodejs"

const ExportRequestSchema = z.object({
  applicationId: z.string().min(1),
})

async function convertDocxToPdfBuffer(docxBuffer: Buffer): Promise<Buffer> {
  // Write DOCX to a temp file
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "docx-to-pdf-"))
  const inputPath = path.join(tmpDir, "input.docx")
  const outputPath = path.join(tmpDir, "input.pdf")

  await fs.promises.writeFile(inputPath, docxBuffer)

  // Invoke LibreOffice (soffice) to convert to PDF. Requires LibreOffice to be installed on the server.
  // Command: soffice --headless --convert-to pdf --outdir <tmpDir> <inputPath>
  await new Promise<void>((resolve, reject) => {
    const args = ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, inputPath]
    const proc = spawn("soffice", args, { stdio: "ignore" })
    proc.on("error", (err) => reject(err))
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`soffice exited ${code}`))))
  })

  const pdfExists = await fs.promises
    .access(outputPath, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false)

  if (!pdfExists) {
    throw new Error("PDF conversion failed: output not found")
  }

  const pdfBuffer = await fs.promises.readFile(outputPath)

  // cleanup
  try {
    await fs.promises.unlink(inputPath)
    await fs.promises.unlink(outputPath)
    await fs.promises.rmdir(tmpDir)
  } catch {}

  return pdfBuffer
}

async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create()

  for (const buf of buffers) {
    const src = await PDFDocument.load(buf)
    const copied = await merged.copyPages(src, src.getPageIndices())
    copied.forEach((p) => merged.addPage(p))
  }

  const mergedBytes = await merged.save()
  return Buffer.from(mergedBytes)
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 })
    }

    if (!adminAuth) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin not initialized" }, { status: 500 })
    }

    const idToken = authHeader.slice(7)
    try {
      await adminAuth.verifyIdToken(idToken)
    } catch (err) {
      return NextResponse.json({ error: "Invalid or expired authentication token" }, { status: 401 })
    }

    let body: any
    try {
      body = await request.json()
    } catch (err) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parse = ExportRequestSchema.safeParse(body)
    if (!parse.success) {
      return NextResponse.json({ error: "Invalid request", details: parse.error.flatten() }, { status: 400 })
    }

    const { applicationId } = parse.data
    const swornOnly = Boolean(body.swornOnly)

    if (!adminDb) {
      return NextResponse.json({ error: "Server misconfigured: Firebase Admin DB not initialized" }, { status: 500 })
    }

    const applicationRef = adminDb.ref(`${BUSINESS_APPLICATION_PATH}/${applicationId}`)
    const snapshot = await applicationRef.get()
    if (!snapshot.exists()) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }

    const applicationData = snapshot.val()
    const formData = applicationData?.form ?? {}

    const templateData = mapApplicationToTemplate(formData)

    let templatePath = "templates/2025_new_business_form_template_with_tags_v2.docx"
    try {
      const appType = String(formData.applicationType ?? "").toLowerCase()
      if (swornOnly) {
        if (appType === "new") {
          templatePath = "templates/Sworn_Statement_of_Capital.docx"
        } else {
          templatePath = "templates/Sworn_Declaration_of_Gross_receipt.docx"
        }
      }
    } catch {}

    const absoluteTemplate = path.resolve(process.cwd(), templatePath)
    if (!fs.existsSync(absoluteTemplate)) {
      return NextResponse.json({ error: "Template file not found on server" }, { status: 500 })
    }

    let docxBuffer: Buffer
    try {
      docxBuffer = renderFromTemplate(templatePath, templateData)
    } catch (err) {
      return NextResponse.json({ error: "Failed to render document", details: String(err) }, { status: 500 })
    }

    let pdfBuffer: Buffer
    try {
      // Convert main docx to PDF
      const mainPdf = await convertDocxToPdfBuffer(docxBuffer)

      // If not swornOnly, try to also render/convert the sworn template and merge PDFs
      if (!swornOnly) {
        try {
          // Determine sworn template path based on application type
          let swornTemplatePath: string | null = null
          try {
            const appType = String(formData.applicationType ?? "").toLowerCase()
            if (appType === "new") {
              swornTemplatePath = "templates/Sworn_Statement_of_Capital.docx"
            } else {
              swornTemplatePath = "templates/Sworn_Declaration_of_Gross_receipt.docx"
            }
          } catch {}

          if (swornTemplatePath) {
            const absSworn = path.resolve(process.cwd(), swornTemplatePath)
            if (fs.existsSync(absSworn)) {
              const swornDocx = renderFromTemplate(swornTemplatePath, templateData)
              const swornPdf = await convertDocxToPdfBuffer(swornDocx)
              // Merge main + sworn
              pdfBuffer = await mergePdfBuffers([mainPdf, swornPdf])
            } else {
              // sworn template missing; return main PDF
              pdfBuffer = mainPdf
            }
          } else {
            pdfBuffer = mainPdf
          }
        } catch (mergeErr) {
          console.warn("Failed to render/merge sworn doc; returning main PDF:", mergeErr)
          pdfBuffer = mainPdf
        }
      } else {
        // swornOnly requested — return only the sworn PDF (main not included)
        // But for swornOnly, templatePath was already switched earlier; mainPdf is actually sworn PDF
        pdfBuffer = mainPdf
      }
    } catch (err) {
      const errStr = String(err || "")
      // If the error is from soffice/LibreOffice or missing binary, don't log full stack to avoid noisy errors.
      if (errStr.toLowerCase().includes("soffice") || errStr.toLowerCase().includes("enoent")) {
        console.warn("Server-side PDF conversion unavailable; soffice failed:", errStr)
        return NextResponse.json({ error: "Failed to convert to PDF", details: errStr }, { status: 500 })
      }

      console.error("PDF conversion error:", err)
      return NextResponse.json({ error: "Failed to convert to PDF", details: errStr }, { status: 500 })
    }

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Application.pdf"`,
        "Content-Length": String(pdfBuffer.length),
      },
    })
  } catch (error) {
    console.error("DOCX->PDF export error:", error)
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 })
  }
}
