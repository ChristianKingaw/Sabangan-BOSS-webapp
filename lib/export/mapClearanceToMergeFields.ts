export type ClearanceNameParts = {
  firstName: string
  middleName: string
  lastName: string
}

type TreasuryLike = {
  cedula_no?: string
  cedula_issued_at?: number | null
  or_no?: string
  or_issued_at?: number | null
} | null | undefined

const pickString = (source: Record<string, any>, keys: string[]) => {
  for (const key of keys) {
    const raw = source?.[key]
    if (raw === null || raw === undefined) continue
    const value = String(raw).trim()
    if (value) return value
  }
  return ""
}

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "")

const pickStringLoose = (source: Record<string, any>, keys: string[]) => {
  const exact = pickString(source, keys)
  if (exact) return exact

  const valuesByNormalizedKey = new Map<string, string>()
  for (const [rawKey, rawValue] of Object.entries(source ?? {})) {
    if (rawValue === null || rawValue === undefined) continue
    const value = String(rawValue).trim()
    if (!value) continue
    valuesByNormalizedKey.set(normalizeKey(rawKey), value)
  }

  for (const key of keys) {
    const matched = valuesByNormalizedKey.get(normalizeKey(key))
    if (matched) return matched
  }

  return ""
}

const asRecord = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, any>
}

const formatDateLabel = (value: unknown) => {
  if (value === null || value === undefined) return ""

  let date: Date
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value)
  } else {
    const raw = String(value).trim()
    if (!raw) return ""
    const numericRaw = Number(raw)
    if (Number.isFinite(numericRaw) && /^\d+$/.test(raw)) {
      date = new Date(numericRaw)
    } else {
      date = new Date(raw)
    }
  }

  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })
}

const getCurrentDateLabel = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date())

const getCurrentIssuedDateLabel = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date())

  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0")
  const month = parts.find((part) => part.type === "month")?.value ?? ""
  const year = parts.find((part) => part.type === "year")?.value ?? ""
  const mod10 = day % 10
  const mod100 = day % 100
  const suffix =
    mod10 === 1 && mod100 !== 11 ? "st" :
    mod10 === 2 && mod100 !== 12 ? "nd" :
    mod10 === 3 && mod100 !== 13 ? "rd" :
    "th"

  return `${day}${suffix} day of ${month} ${year}`.trim()
}

const splitName = (form: Record<string, any>): ClearanceNameParts => {
  const firstName = pickString(form, ["firstName", "firstname", "givenName"])
  const middleName = pickString(form, ["middleName", "middlename", "middle_name"])
  const lastName = pickString(form, ["lastName", "lastname", "surname"])
  if (firstName || middleName || lastName) {
    return { firstName, middleName, lastName }
  }

  const fullName = pickString(form, ["fullName", "name", "applicantName"])
  if (!fullName) {
    return { firstName: "", middleName: "", lastName: "" }
  }

  if (fullName.includes(",")) {
    const [lastPart, rest] = fullName.split(",").map((part) => part.trim())
    const restParts = rest ? rest.split(/\s+/).filter(Boolean) : []
    return {
      firstName: restParts[0] ?? "",
      middleName: restParts.slice(1).join(" "),
      lastName: lastPart ?? "",
    }
  }

  const parts = fullName.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstName: parts[0] ?? "", middleName: "", lastName: "" }
  if (parts.length === 2) return { firstName: parts[0], middleName: "", lastName: parts[1] }
  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(" "),
    lastName: parts[parts.length - 1],
  }
}

export function mapClearanceToMergeFields(
  payload: any,
  applicationId: string,
  treasuryAssessment?: TreasuryLike
) {
  const form = (payload?.form ?? payload ?? {}) as Record<string, any>
  const meta = (payload?.meta ?? {}) as Record<string, any>
  const root = (payload ?? {}) as Record<string, any>
  const formAddress = asRecord(form.address)
  const rootAddress = asRecord(root.address)
  const name = splitName(form)
  const applicantName = [name.firstName, name.middleName, name.lastName]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  const businessType = (
    pickStringLoose(form, [
      "businessType",
      "typeOfBusiness",
      "businessClassification",
      "organizationType",
      "entityType",
      "ownershipType",
      "businessStructure",
      "companyType",
    ]) ||
    pickStringLoose(meta, [
      "businessType",
      "typeOfBusiness",
      "businessClassification",
      "organizationType",
      "entityType",
      "ownershipType",
      "businessStructure",
      "companyType",
    ]) ||
    pickStringLoose(root, [
      "businessType",
      "typeOfBusiness",
      "businessClassification",
      "organizationType",
      "entityType",
      "ownershipType",
      "businessStructure",
      "companyType",
    ])
  ).toLowerCase()
  const resolvedBusinessName =
    pickStringLoose(form, ["businessName", "tradeName", "companyName", "establishmentName"]) ||
    pickStringLoose(meta, ["businessName", "tradeName", "companyName", "establishmentName"]) ||
    pickStringLoose(root, ["businessName", "tradeName", "companyName", "establishmentName"])
  const rawBusinessAddress =
    pickStringLoose(form, ["businessAddress", "businessAdress", "address", "businessLocation"]) ||
    pickStringLoose(formAddress, ["fullAddress", "address", "street", "line1"]) ||
    pickStringLoose(meta, ["businessAddress", "businessAdress", "address", "businessLocation"]) ||
    pickStringLoose(root, ["businessAddress", "businessAdress", "address", "businessLocation"]) ||
    pickStringLoose(rootAddress, ["fullAddress", "address", "street", "line1"])
  const rawOwnerAddress =
    pickStringLoose(form, ["ownerAddress", "ownerAdress", "residentialAddress", "homeAddress"]) ||
    pickStringLoose(meta, ["ownerAddress", "ownerAdress", "residentialAddress", "homeAddress"]) ||
    pickStringLoose(root, ["ownerAddress", "ownerAdress", "residentialAddress", "homeAddress"])
  const purpose =
    pickString(form, ["purpose", "reason", "applicationPurpose", "clearancePurpose"]) || "Mayor's Clearance"
  const currentDate1st = getCurrentDateLabel()
  const currentDate2nd = getCurrentIssuedDateLabel()
  const treasuryOrDate =
    formatDateLabel(treasuryAssessment?.or_issued_at) ||
    formatDateLabel(treasuryAssessment?.cedula_issued_at)
  const orDate =
    treasuryOrDate ||
    formatDateLabel(
      pickString(form, ["orDate", "ORDate", "officialReceiptDate", "officialReceiptIssuedDate", "receiptDate"])
    ) || currentDate1st
  const mayorsClearanceNoKeys = [
    "mayorsClearanceNo",
    "mayorClearanceNo",
    "mayors_clearance_no",
    "mayor_clearance_no",
    "Mayor's Clearance No",
    "Mayors Clearance No",
    "clearanceNo",
    "clearance_no",
    "clearanceNumber",
    "clearance_number",
    "mcNo",
    "mc_no",
    "registrationNo",
    "registration_no",
    "regNo",
    "reg_no",
    "no",
  ]
  const clearanceNo =
    pickStringLoose(form, mayorsClearanceNoKeys) ||
    pickStringLoose(meta, mayorsClearanceNoKeys) ||
    pickStringLoose(root, mayorsClearanceNoKeys)
  const resolvedCedulaNo =
    String(treasuryAssessment?.cedula_no ?? "").trim() ||
    pickStringLoose(form, ["cedulaNo", "cedulaNumber", "communityTaxCertificateNo", "ctcNo"])
  const barangay =
    pickStringLoose(formAddress, ["barangay", "barangayName", "name"]) ||
    pickStringLoose(form, ["barangay", "barangayName", "addressBarangay", "residentialBarangay"]) ||
    pickStringLoose(meta, ["barangay", "barangayName"]) ||
    pickStringLoose(rootAddress, ["barangay", "barangayName", "name"]) ||
    pickStringLoose(root, ["barangay", "barangayName", "addressBarangay", "residentialBarangay"])
  const town =
    pickStringLoose(formAddress, ["town", "townName", "municipality", "city"]) ||
    pickStringLoose(form, ["town", "townName", "municipality", "city"]) ||
    pickStringLoose(meta, ["town", "townName", "municipality", "city"]) ||
    pickStringLoose(rootAddress, ["town", "townName", "municipality", "city"]) ||
    pickStringLoose(root, ["town", "townName", "municipality", "city"])
  const municipality =
    pickStringLoose(formAddress, ["municipality", "municipalityName", "city"]) ||
    pickStringLoose(form, ["municipality", "municipalityName", "city"]) ||
    pickStringLoose(meta, ["municipality", "municipalityName", "city"]) ||
    pickStringLoose(rootAddress, ["municipality", "municipalityName", "city"]) ||
    pickStringLoose(root, ["municipality", "municipalityName", "city"]) ||
    town
  const province =
    pickStringLoose(formAddress, ["province", "provinceName"]) ||
    pickStringLoose(form, ["province", "provinceName"]) ||
    pickStringLoose(meta, ["province", "provinceName"]) ||
    pickStringLoose(rootAddress, ["province", "provinceName"]) ||
    pickStringLoose(root, ["province", "provinceName"])
  const explicitCityProvince =
    pickStringLoose(formAddress, ["city/province", "cityProvince", "city_province"]) ||
    pickStringLoose(form, ["city/province", "cityProvince", "city_province"]) ||
    pickStringLoose(meta, ["city/province", "cityProvince", "city_province"]) ||
    pickStringLoose(rootAddress, ["city/province", "cityProvince", "city_province"]) ||
    pickStringLoose(root, ["city/province", "cityProvince", "city_province"])
  const resolvedTown = town || municipality
  const inferredProvince =
    !province && /sabangan/i.test(resolvedTown) ? "Mountain Province" : ""
  const resolvedProvince = province || inferredProvince
  const townProvince = [resolvedTown, resolvedProvince].filter(Boolean).join(", ")
  const resolvedBusinessAddress = rawBusinessAddress || [barangay, townProvince].filter(Boolean).join(", ")
  const resolvedOwnerAddress = rawOwnerAddress || resolvedBusinessAddress
  const cityProvince =
    explicitCityProvince ||
    resolvedProvince ||
    municipality
  const resolvedOfficialReceiptNo =
    pickStringLoose(form, ["officialReceiptNo", "orNo", "ORNo", "receiptNo"]) ||
    String(treasuryAssessment?.or_no ?? "").trim()

  return {
    name,
    businessType,
    mergeFields: {
      No: clearanceNo,
      no: clearanceNo,
      First_Name: name.firstName,
      Middle_Name: name.middleName,
      Last_Name: name.lastName,
      firstName: name.firstName,
      middleName: name.middleName,
      lastName: name.lastName,
      applicantName,
      businessName: resolvedBusinessName,
      businessAddress: resolvedBusinessAddress,
      businessAdress: resolvedBusinessAddress,
      ownerAddress: resolvedOwnerAddress,
      ownerAdress: resolvedOwnerAddress,
      OwnerAddress: resolvedOwnerAddress,
      Barangay: barangay,
      barangay,
      Town: resolvedTown,
      town: resolvedTown,
      Municipality: municipality,
      municipality,
      Province: resolvedProvince,
      province: resolvedProvince,
      "city/province": cityProvince,
      cityProvince,
      city_province: cityProvince,
      City_Province: cityProvince,
      "town/province": townProvince,
      townProvince,
      town_province: townProvince,
      townAndProvince: townProvince,
      TownAndProvince: townProvince,
      town_and_province: townProvince,
      Town_And_Province: townProvince,
      Cedula_No: resolvedCedulaNo,
      cedulaNo: resolvedCedulaNo,
      Place_of_Issuance:
        pickString(form, ["placeOfIssuance", "cedulaPlaceIssued", "issuedAt", "issuePlace"]) ||
        "Sabangan, Mountain Province",
      Purpose: purpose,
      OR_No: resolvedOfficialReceiptNo,
      ORNo: resolvedOfficialReceiptNo,
      orNo: resolvedOfficialReceiptNo,
      officialReceiptNo: resolvedOfficialReceiptNo,
      OfficialReceiptNo: resolvedOfficialReceiptNo,
      official_receipt_no: resolvedOfficialReceiptNo,
      OR_date: orDate,
      currentDate1st,
      currentDate2nd,
    } satisfies Record<string, string>,
  }
}
