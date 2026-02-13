/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensure document templates are included in server bundle for SSR/API runtimes.
  outputFileTracingIncludes: {
    "/api/export/application-docs": ["./templates/**/*"],
    "/api/export/clearance-template": ["./templates/**/*"],
    "/api/export/docx": ["./templates/**/*"],
    "/api/export/docx-to-pdf": ["./templates/**/*"],
  },
};

module.exports = nextConfig;
