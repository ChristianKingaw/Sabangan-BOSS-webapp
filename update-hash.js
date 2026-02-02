const fs = require("fs");
const path = "app/page.tsx";
const pattern = /async function hashPassword[\s\S]*?\n}\r?\n/;
const newSnippet = [
  "async function hashPassword(value: string) {",
  "  const cryptoObj = globalThis.crypto ?? (typeof window !== \"undefined\" ? window.crypto : undefined)",
  "  if (!cryptoObj?.subtle) {",
  "    throw new Error(\"Password hashing requires Web Crypto support.\")",
  "  }",
  "",
  "  const encoder = new TextEncoder()",
  "  const data = encoder.encode(value)",
  "  const hashBuffer = await cryptoObj.subtle.digest(\"SHA-256\", data)",
  "  const hashArray = Array.from(new Uint8Array(hashBuffer))",
  "  return hashArray.map((b) => b.toString(16).padStart(2, \"0\")).join(\"\")",
  "}",
  ""
].join("\r\n");
let text = fs.readFileSync(path, "utf8");
if (!pattern.test(text)) {
  throw new Error("hashPassword() pattern not found");
}
text = text.replace(pattern, `${newSnippet}\r\n`);
fs.writeFileSync(path, text);
