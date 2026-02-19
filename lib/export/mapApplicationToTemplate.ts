/**
 * Maps Firestore business application data to template tags for DOCX generation.
 * This is the "contract layer" between database fields and template placeholders.
 */
import {
  buildTemplateTreasuryFields,
  type TreasuryAssessmentRecord,
} from "@/lib/treasury-assessment"

export type Activity = {
  lineOfBusiness: string
  noOfUnits: string
  capitalization: string
  grossSalesReceipts: string
}

export type TemplateData = {
  // Application type checkboxes
  appNewBox: string
  appRenewalBox: string

  // Payment mode checkboxes
  payAnnuallyBox: string
  paySemiAnnuallyBox: string
  payQuarterlyBox: string

  // Business type checkboxes
  typeSingleBox: string
  typePartnershipBox: string
  typeCorporationBox: string
  typeCooperativeBox: string

  // Amendment checkboxes (From)
  amendFromSingleBox: string
  amendFromPartnershipBox: string
  amendFromCorporationBox: string

  // Amendment checkboxes (To)
  amendToSingleBox: string
  amendToPartnershipBox: string
  amendToCorporationBox: string

  // Tax incentive checkboxes
  taxIncentiveYesBox: string
  taxIncentiveNoBox: string

  // Core form fields
  dateOfApplication: string
  registrationNo: string
  tin: string
  registrationDate: string

  // Name / business identity
  taxpayerRegistrant: string
  lastName: string
  firstName: string
  middleName: string
  businessName: string
  tradeName: string

  // Business address / contact
  businessAddress: string
  businessPostalCode: string
  businessMobile: string
  businessEmail: string

  // Owner address / contact
  ownerAddress: string
  ownerPostalCode: string
  ownerMobile: string
  ownerEmail: string

  // Emergency contact
  emergencyContactName: string
  emergencyMobile: string

  // Employees
  totalEmployees: string
  femaleEmployees: string

  // Rental info
  lessorName: string

  // Tax incentive entity
  taxIncentiveEntity: string

  // Capital investment (for Sworn Statement of Capital - New businesses)
  capitalInvestment: string
  capitalInvestmentWords: string

  // Gross sales receipts total (for Sworn Declaration - Renewal businesses)
  grossSalesReceipts: string
  grossSalesReceiptsWords: string

  // Activities (line of business) - loop
  activities: Activity[]

  // Treasury assessment values (optional; used when treasury already assessed fees)
  treasuryCedulaNo?: string
  treasuryCedulaIssuedAt?: string | number
  treasuryOrNo?: string
  treasuryOrIssuedAt?: string | number
  treasuryOthers?: string
  others?: string
  otherFees?: string
  otherFeeNames?: string
  others_amount?: string | number
  others_penalty?: string | number
  others_total?: string | number
  other_amount?: string | number
  other_penalty?: string | number
  other_total?: string | number
  treasury_others_amount?: string | number
  treasury_others_penalty?: string | number
  treasury_others_total?: string | number
  grand_total?: string | number
  lgu_total?: string | number
  treasuryGrandTotal?: string | number
  treasuryLguTotal?: string | number

  [key: string]: unknown
}

const CHECKED = "☑"
const UNCHECKED = "☐"

/**
 * Format a date string to a readable format
 */
function formatDate(dateStr?: string): string {
  if (!dateStr) return ""
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/**
 * Format currency/number values
 */
function formatCurrency(value?: string | number): string {
  if (!value) return ""
  const num = typeof value === "string" ? parseFloat(value) : value
  if (Number.isNaN(num)) return String(value)
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Format a number as an integer with thousands separators (no decimals)
 */
function formatInteger(value?: string | number): string {
  if (value === undefined || value === null || value === "") return ""
  const num = typeof value === "string" ? parseFloat(String(value).replace(/,/g, "")) : Number(value)
  if (Number.isNaN(num)) return String(value)
  return Math.round(num).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

/**
 * Normalize address separators. Replace slashes with commas and tidy spacing.
 */
function formatAddress(value?: unknown): string {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  return raw
    .replace(/\s*\/\s*/g, ", ") // turn "/" separators into commas
    .replace(/\s*,\s*/g, ", ") // normalize comma spacing
    .replace(/,\s*,+/g, ", ") // collapse consecutive commas
    .replace(/,\s*$/, "") // drop trailing comma
}

/**
 * Convert a number to English words (handles integer part up to trillions)
 * and returns "Words and NN/100" for cents.
 */
function convertAmountToWords(input?: string | number): string {
  if (input === undefined || input === null || input === "") return ""
  const n = typeof input === "string" ? parseFloat(String(input).replace(/,/g, "")) : Number(input)
  if (!isFinite(n)) return String(input)

  const negative = n < 0
  const abs = Math.abs(n)
  const integerPart = Math.floor(abs)
  const cents = Math.round((abs - integerPart) * 100)

  const units: string[] = [
    "Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
    "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"
  ]
  const tens: string[] = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"]

  function integerToWords(num: number): string {
    if (num < 20) return units[num]
    if (num < 100) {
      const t = Math.floor(num / 10)
      const r = num % 10
      return tens[t] + (r ? ` ${units[r]}` : "")
    }
    if (num < 1000) {
      const h = Math.floor(num / 100)
      const r = num % 100
      return `${units[h]} Hundred${r ? ` ${integerToWords(r)}` : ""}`
    }

    const scales = [
      { value: 1_000_000_000_000, name: "Trillion" },
      { value: 1_000_000_000, name: "Billion" },
      { value: 1_000_000, name: "Million" },
      { value: 1_000, name: "Thousand" },
    ]

    for (const scale of scales) {
      if (num >= scale.value) {
        const high = Math.floor(num / scale.value)
        const rest = num % scale.value
        return `${integerToWords(high)} ${scale.name}${rest ? ` ${integerToWords(rest)}` : ""}`
      }
    }

    return ""
  }

  const words = integerToWords(integerPart) || "Zero"
  const centsStr = String(cents).padStart(2, "0")
  if (cents === 0) {
    return `${negative ? "Minus " : ""}${words}`
  }
  return `${negative ? "Minus " : ""}${words} and ${centsStr}/100`
}

/**
 * Map Firestore application data to template data model
 */
export function mapApplicationToTemplate(
  form: Record<string, unknown>,
  treasuryAssessment?: TreasuryAssessmentRecord | null
): TemplateData {
  const applicationType = String(form.applicationType ?? "").toLowerCase()
  const businessType = String(form.businessType ?? "").toLowerCase()
  const taxIncentive = String(form.taxIncentive ?? "").toLowerCase()
  const paymentMode = String(form.paymentMode ?? "").toLowerCase()

  // Amendment fields (if present)
  const amendFrom = String(form.amendFrom ?? "").toLowerCase()
  const amendTo = String(form.amendTo ?? "").toLowerCase()

  // Parse activities array
  const rawActivities = Array.isArray(form.activities) ? form.activities : []
  const activities: Activity[] = rawActivities.map((activity: Record<string, unknown>) => ({
    lineOfBusiness: String(activity.lineOfBusiness ?? ""),
    noOfUnits: String(activity.tricycleUnits ?? activity.noOfUnits ?? ""),
    capitalization: formatInteger(activity.capitalization as string | number | undefined),
    grossSalesReceipts: formatInteger((activity.grossSales ?? activity.grossSalesReceipts ?? "") as string | number | undefined),
  }))

  // Build full name for taxpayer/registrant
  const fullName = [
    String(form.firstName ?? ""),
    String(form.middleName ?? ""),
    String(form.lastName ?? ""),
  ]
    .filter(Boolean)
    .join(" ")
    .trim()

  // Employee counts
  const totalEmployees = parseInt(String(form.totalEmployees ?? 0), 10) || 0
  const femaleEmployees = parseInt(String(form.totalFemaleEmployees ?? form.femaleEmployees ?? 0), 10) || 0

  // Capital & gross totals as numbers
  const capitalTotal = rawActivities.reduce((sum: number, activity: Record<string, unknown>) => {
    const value = parseFloat(String(activity.capitalization ?? 0).replace(/,/g, ""))
    return sum + (Number.isNaN(value) ? 0 : value)
  }, 0)

  const grossTotal = rawActivities.reduce((sum: number, activity: Record<string, unknown>) => {
    const value = parseFloat(String(activity.grossSales ?? activity.grossSalesReceipts ?? 0).replace(/,/g, ""))
    return sum + (Number.isNaN(value) ? 0 : value)
  }, 0)
  const treasuryTemplateFields = buildTemplateTreasuryFields(treasuryAssessment)

  return {
    // Application type checkboxes
    appNewBox: applicationType === "new" ? CHECKED : UNCHECKED,
    appRenewalBox: applicationType === "renewal" ? CHECKED : UNCHECKED,

    // Payment mode checkboxes
    payAnnuallyBox: paymentMode === "annually" ? CHECKED : UNCHECKED,
    paySemiAnnuallyBox: paymentMode === "semi-annually" || paymentMode === "semiannually" ? CHECKED : UNCHECKED,
    payQuarterlyBox: paymentMode === "quarterly" ? CHECKED : UNCHECKED,

    // Business type checkboxes
    typeSingleBox: businessType === "single" ? CHECKED : UNCHECKED,
    typePartnershipBox: businessType === "partnership" ? CHECKED : UNCHECKED,
    typeCorporationBox: businessType === "corporation" ? CHECKED : UNCHECKED,
    typeCooperativeBox: businessType === "cooperative" ? CHECKED : UNCHECKED,

    // Amendment checkboxes (From)
    amendFromSingleBox: amendFrom === "single" ? CHECKED : UNCHECKED,
    amendFromPartnershipBox: amendFrom === "partnership" ? CHECKED : UNCHECKED,
    amendFromCorporationBox: amendFrom === "corporation" ? CHECKED : UNCHECKED,

    // Amendment checkboxes (To)
    amendToSingleBox: amendTo === "single" ? CHECKED : UNCHECKED,
    amendToPartnershipBox: amendTo === "partnership" ? CHECKED : UNCHECKED,
    amendToCorporationBox: amendTo === "corporation" ? CHECKED : UNCHECKED,

    // Tax incentive checkboxes
    taxIncentiveYesBox: taxIncentive === "yes" ? CHECKED : UNCHECKED,
    taxIncentiveNoBox: taxIncentive === "no" || !taxIncentive ? CHECKED : UNCHECKED,

    // Core form fields
    dateOfApplication: formatDate(String(form.dateOfApplication ?? "")),
    registrationNo: String(form.registrationNo ?? ""),
    tin: String(form.tin ?? ""),
    registrationDate: formatDate(String(form.registrationDate ?? "")),

    // Name / business identity
    taxpayerRegistrant: fullName || String(form.businessName ?? ""),
    lastName: String(form.lastName ?? ""),
    firstName: String(form.firstName ?? ""),
    middleName: String(form.middleName ?? ""),
    businessName: String(form.businessName ?? ""),
    tradeName: String(form.tradeName ?? ""),

    // Business address / contact
    businessAddress: formatAddress(form.businessAddress),
    businessPostalCode: String(form.businessPostalCode ?? ""),
    businessMobile: String(form.businessMobile ?? ""),
    businessEmail: String(form.businessEmail ?? ""),

    // Owner address / contact
    ownerAddress: String(form.ownerAddress ?? ""),
    ownerPostalCode: String(form.ownerPostalCode ?? ""),
    ownerMobile: String(form.ownerMobile ?? ""),
    ownerEmail: String(form.ownerEmail ?? ""),

    // Emergency contact
    emergencyContactName: String(form.emergencyContactName ?? ""),
    emergencyMobile: String(form.emergencyContactMobile ?? form.emergencyMobile ?? ""),

    // Employees
    totalEmployees: totalEmployees > 0 ? String(totalEmployees) : "",
    femaleEmployees: femaleEmployees > 0 ? String(femaleEmployees) : "",

    // Rental info
    lessorName: String(form.lessorName ?? ""),

    // Tax incentive entity
    taxIncentiveEntity: String(form.incentiveEntity ?? form.taxIncentiveEntity ?? ""),

    // Capital investment (sum of all capitalizations for Sworn Statement)
    capitalInvestment: capitalTotal > 0 ? formatInteger(capitalTotal) : "",
    capitalInvestmentWords: capitalTotal > 0 ? convertAmountToWords(capitalTotal) : "",

    // Gross sales receipts total (for Sworn Declaration)
    grossSalesReceipts: grossTotal > 0 ? formatInteger(grossTotal) : "",
    grossSalesReceiptsWords: grossTotal > 0 ? convertAmountToWords(grossTotal) : "",

    // Activities
    activities,

    // Treasury assessment (if available)
    ...treasuryTemplateFields,
  }
}
