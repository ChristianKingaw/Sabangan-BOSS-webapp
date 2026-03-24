export type SanitaryPermitTemplateData = {
  businessName: string
  fullName: string
  businessAddress: string
}

const normalizeString = (value: unknown) => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim()
  return ""
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "")

const pickStringLoose = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = normalizeString(source[key])
    if (value) return value
  }

  const normalizedSource = new Map<string, string>()
  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const normalizedValue = normalizeString(rawValue)
    if (!normalizedValue) return
    normalizedSource.set(normalizeKey(rawKey), normalizedValue)
  })

  for (const key of keys) {
    const matched = normalizedSource.get(normalizeKey(key))
    if (matched) return matched
  }

  return ""
}

const formatAddress = (value: string) =>
  value
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/,\s*$/, "")
    .trim()

export function mapSanitaryPermitToTemplate(
  applicationForm: Record<string, unknown>
): SanitaryPermitTemplateData {
  const firstName = normalizeString(applicationForm.firstName)
  const middleName = normalizeString(applicationForm.middleName)
  const lastName = normalizeString(applicationForm.lastName)
  const fullName =
    [firstName, middleName, lastName].filter(Boolean).join(" ") ||
    normalizeString(applicationForm.fullName) ||
    normalizeString(applicationForm.applicantName) ||
    "N/A"

  const businessName = normalizeString(applicationForm.businessName) || "N/A"

  const addressNode = asRecord(applicationForm.address)
  const rawBusinessAddress =
    pickStringLoose(applicationForm, [
      "businessAddress",
      "businessAdress",
      "businessLocation",
      "address",
    ]) || pickStringLoose(addressNode, ["fullAddress", "address", "street", "line1"])

  const barangay =
    pickStringLoose(addressNode, ["barangay", "barangayName", "name"]) ||
    pickStringLoose(applicationForm, ["barangay", "barangayName", "addressBarangay"])
  const town =
    pickStringLoose(addressNode, ["town", "townName", "municipality", "city"]) ||
    pickStringLoose(applicationForm, ["town", "townName", "municipality", "city"])
  const province =
    pickStringLoose(addressNode, ["province", "provinceName"]) ||
    pickStringLoose(applicationForm, ["province", "provinceName"])

  const inferredProvince = !province && /sabangan/i.test(town) ? "Mountain Province" : ""
  const townProvince = [town, province || inferredProvince].filter(Boolean).join(", ")
  const fallbackAddress = [barangay, townProvince].filter(Boolean).join(", ")
  const businessAddress = formatAddress(rawBusinessAddress || fallbackAddress) || "N/A"

  return {
    businessName,
    fullName,
    businessAddress,
  }
}
