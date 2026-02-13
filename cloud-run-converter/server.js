const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { PDFDocument } = require("pdf-lib");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "cloud-run-converter" });
});

/**
 * Convert DOCX buffer to PDF using LibreOffice headless
 */
async function convertDocxToPdf(docxBuffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "docx-"));
  const inputPath = path.join(tmpDir, "input.docx");
  const outputPath = path.join(tmpDir, "input.pdf");
  const userProfileDir = path.join(tmpDir, "lo-profile");
  let lastStderr = "";

  try {
    await fs.promises.writeFile(inputPath, docxBuffer);
    await fs.promises.mkdir(userProfileDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const args = [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--norestore",
        `-env:UserInstallation=file://${userProfileDir}/`,
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        tmpDir,
        inputPath,
      ];
      const proc = spawn("soffice", args, {
        stdio: "pipe",
        env: {
          ...process.env,
          HOME: "/tmp",
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
        },
      });

      proc.stderr?.on("data", (d) => (lastStderr += d.toString()));

      proc.on("error", (err) => reject(err));
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`soffice exited with code ${code}: ${lastStderr}`));
      });
    });

    let pdfExists = await fs.promises
      .access(outputPath, fs.constants.R_OK)
      .then(() => true)
      .catch(() => false);

    if (!pdfExists) {
      // Give LibreOffice a short grace period to flush the output file.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 200));
        pdfExists = await fs.promises
          .access(outputPath, fs.constants.R_OK)
          .then(() => true)
          .catch(() => false);
        if (pdfExists) break;
      }
    }

    if (!pdfExists) {
      const detail = lastStderr ? ` stderr: ${lastStderr}` : "";
      throw new Error(`PDF conversion failed: output not found.${detail}`);
    }

    const pdfBuffer = await fs.promises.readFile(outputPath);
    return pdfBuffer;
  } finally {
    // Cleanup
    try {
      await fs.promises.unlink(inputPath).catch(() => {});
      await fs.promises.unlink(outputPath).catch(() => {});
      await fs.promises.rmdir(tmpDir).catch(() => {});
    } catch {}
  }
}

/**
 * Convert image to PDF using pdf-lib
 */
async function convertImageToPdf(imageBuffer, mimeType) {
  const pdfDoc = await PDFDocument.create();

  let image;
  if (mimeType === "image/png") {
    image = await pdfDoc.embedPng(imageBuffer);
  } else if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    image = await pdfDoc.embedJpg(imageBuffer);
  } else {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * POST /convert/docx-to-pdf
 * Accepts multipart form with 'file' field containing DOCX
 */
app.post("/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const pdfBuffer = await convertDocxToPdf(req.file.buffer);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("DOCX to PDF conversion error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

/**
 * POST /convert/image-to-pdf
 * Accepts multipart form with 'file' field containing PNG/JPEG
 */
app.post("/convert/image-to-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const pdfBuffer = await convertImageToPdf(req.file.buffer, req.file.mimetype);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Image to PDF conversion error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

/**
 * POST /convert/images-to-pdf
 * Accepts multipart form with multiple 'files' fields containing PNG/JPEG
 * Merges all images into a single PDF
 */
app.post("/convert/images-to-pdf", upload.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      let image;
      if (file.mimetype === "image/png") {
        image = await pdfDoc.embedPng(file.buffer);
      } else if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") {
        image = await pdfDoc.embedJpg(file.buffer);
      } else {
        continue; // Skip unsupported formats
      }

      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    }

    const pdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=merged.pdf");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Images to PDF conversion error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Converter service listening on port ${PORT}`);
});
