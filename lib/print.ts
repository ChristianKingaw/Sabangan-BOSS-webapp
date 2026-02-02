export function handlePrintHtml(html: string | null, title = "Document", extraHtml: string | null = null) {
  if (!html && !extraHtml) return

  try {
    const iframe = document.createElement("iframe")
    iframe.style.position = "fixed"
    iframe.style.right = "0"
    iframe.style.bottom = "0"
    iframe.style.width = "0"
    iframe.style.height = "0"
    iframe.style.border = "0"

    document.body.appendChild(iframe)

    const doc = iframe.contentDocument || iframe.contentWindow?.document
    if (!doc) return

    doc.open()
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title}</title>
          <style>
            @page { size: auto; margin: 10mm; }
            html, body { height: auto; -webkit-print-color-adjust: exact; color-adjust: exact; }
            body { margin: 0; padding: 0; background: white; font-family: Arial, sans-serif; }
            .docx-preview { box-shadow: none !important; background: white !important; }
            .docx-preview * { page-break-inside: avoid; }
          </style>
        </head>
        <body>
          ${html ?? ""}
          ${extraHtml ? '<div style="page-break-after: always;"></div>' + extraHtml : ""}
        </body>
      </html>
    `)
    doc.close()

    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
      } catch (err) {
        console.error("Print failed", err)
      }

      // cleanup after print
      setTimeout(() => {
        try {
          if (iframe.parentNode) document.body.removeChild(iframe)
        } catch {}
      }, 1000)
    }
  } catch (err) {
    console.error("Error preparing iframe print", err)
  }
}

export function handlePrintPdf(pdfUrl: string | null, title = "Document PDF") {
  if (!pdfUrl) return
  try {
    const iframe = document.createElement("iframe")
    iframe.style.position = "fixed"
    iframe.style.right = "0"
    iframe.style.bottom = "0"
    iframe.style.width = "0"
    iframe.style.height = "0"
    iframe.style.border = "0"
    iframe.src = pdfUrl

    document.body.appendChild(iframe)

    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
      } catch (err) {
        console.error("PDF print failed", err)
      }

      setTimeout(() => {
        try {
          if (iframe.parentNode) document.body.removeChild(iframe)
        } catch {}
      }, 1000)
    }
  } catch (err) {
    console.error("Error preparing PDF iframe print", err)
  }
}
