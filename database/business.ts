import { ref, push, set, get, update, remove } from "firebase/database"
import { realtimeDb } from "@/database/firebase"
import { BUSINESS_APPLICATION_PATH } from "@/lib/business-applications"

// The creation path for businesses - saved directly under business/creation
const CREATION_PATH = "business/creation"

export type BusinessRequirement = {
  id: string
  name: string
  status: "pending" | "approved" | "rejected"
  rejectionReason?: string
}

export type BusinessRecord = {
  id: string
  businessName: string
  businessType: "New" | "Renewal"
  requirements: BusinessRequirement[]
}

export type CreateBusinessInput = {
  businessName: string
  businessType: "New" | "Renewal"
  requirements: Array<{ name: string }>
}

/**
 * Create a new business record with its requirements
 */
export async function createBusinessRecord(data: CreateBusinessInput): Promise<string> {
  const businessCollectionRef = ref(realtimeDb, CREATION_PATH)
  const newBusinessRef = push(businessCollectionRef)

  if (!newBusinessRef.key) {
    throw new Error("Unable to create business record. Please try again.")
  }

  const requirements: Record<string, Omit<BusinessRequirement, "id">> = {}
  data.requirements.forEach((req, index) => {
    const reqId = `req_${Date.now()}_${index}`
    requirements[reqId] = {
      name: req.name,
      status: "pending",
    }
  })

  const businessData = {
    businessName: data.businessName.trim(),
    businessType: data.businessType,
    requirements,
  }

  await set(newBusinessRef, businessData)

  return newBusinessRef.key
}

/**
 * Get all businesses from the creation path
 */
export async function getAllBusinesses(): Promise<BusinessRecord[]> {
  const businessRef = ref(realtimeDb, CREATION_PATH)
  const snapshot = await get(businessRef)

  if (!snapshot.exists()) {
    return []
  }

  const businesses: BusinessRecord[] = []

  snapshot.forEach((child) => {
    const data = child.val()
    const requirements: BusinessRequirement[] = []

    if (data.requirements) {
      Object.entries(data.requirements).forEach(([reqId, reqData]: [string, any]) => {
        requirements.push({
          id: reqId,
          name: reqData.name ?? "",
          status: reqData.status ?? "pending",
          rejectionReason: reqData.rejectionReason,
        })
      })
    }

    businesses.push({
      id: child.key!,
      businessName: data.businessName ?? "",
      businessType: data.businessType ?? "New",
      requirements,
    })
  })

  return businesses
}

/**
 * Get a single business by ID
 */
export async function getBusinessById(businessId: string): Promise<BusinessRecord | null> {
  const businessRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}`)
  const snapshot = await get(businessRef)

  if (!snapshot.exists()) {
    return null
  }

  const data = snapshot.val()
  const requirements: BusinessRequirement[] = []

  if (data.requirements) {
    Object.entries(data.requirements).forEach(([reqId, reqData]: [string, any]) => {
      requirements.push({
        id: reqId,
        name: reqData.name ?? "",
        status: reqData.status ?? "pending",
        rejectionReason: reqData.rejectionReason,
      })
    })
  }

  return {
    id: businessId,
    businessName: data.businessName ?? "",
    businessType: data.businessType ?? "New",
    requirements,
  }
}

/**
 * Update a business record
 */
export async function updateBusinessRecord(
  businessId: string,
  data: Partial<Omit<BusinessRecord, "id" | "requirements">>
): Promise<void> {
  const businessRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}`)
  await update(businessRef, data)
}

/**
 * Update a requirement status
 */
export async function updateRequirementStatus(
  businessId: string,
  requirementId: string,
  status: "pending" | "approved" | "rejected",
  rejectionReason?: string
): Promise<void> {
  const reqRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}/requirements/${requirementId}`)
  // Read the existing requirement to include its name in the chat message
  const snapshot = await get(reqRef)
  const existingReq = snapshot.exists() ? snapshot.val() : null
  const reqName = existingReq?.name ?? requirementId

  const updateData: { status: string; rejectionReason?: string } = { status }
  if (rejectionReason) {
    updateData.rejectionReason = rejectionReason
  }

  await update(reqRef, updateData)

  // If the requirement was rejected, push an issue message into the business chat
  if (status === "rejected") {
    try {
      const messageText = rejectionReason
        ? `Requirement "${reqName}" rejected: ${rejectionReason}`
        : `Requirement "${reqName}" rejected.`

      // Push to creation chat (existing behavior)
      const chatRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}/chat`)
      await push(chatRef, { senderRole: "admin", text: messageText, ts: Date.now() })

      // Also push to the application messenger path so the message appears in the messenger UI
      try {
        // Ensure the application node has a business name so the messenger includes it in the list
        try {
          const creationNodeRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}`)
          const creationSnap = await get(creationNodeRef)
          const businessName = creationSnap.exists() ? creationSnap.val()?.businessName : undefined
          if (businessName) {
            const appFormRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${businessId}/form`)
            await update(appFormRef, { businessName })
          }
        } catch (formErr) {
          // eslint-disable-next-line no-console
          console.error("Failed to ensure application form businessName:", formErr)
        }

        // Use the requirement's name as the key under the application requirements so the messenger labels it
        const reqKey = existingReq?.name ?? requirementId
        const appReqChatRef = ref(realtimeDb, `${BUSINESS_APPLICATION_PATH}/${businessId}/requirements/${reqKey}/chat`)
        const reasonText = rejectionReason ?? "Rejected"
        await push(appReqChatRef, { senderRole: "admin", text: reasonText, ts: Date.now() })
      } catch (innerErr) {
        // eslint-disable-next-line no-console
        console.error("Failed to push to BUSINESS_APPLICATION_PATH chat:", innerErr)
      }
    } catch (err) {
      // Log but do not fail the main update
      // eslint-disable-next-line no-console
      console.error("Failed to push rejection chat message:", err)
    }
  }
}

/**
 * Add a new requirement to an existing business
 */
export async function addRequirementToBusiness(
  businessId: string,
  requirementName: string
): Promise<string> {
  const requirementsRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}/requirements`)
  const reqId = `req_${Date.now()}`
  
  const newRequirement = {
    name: requirementName.trim(),
    status: "pending" as const,
  }
  
  const reqRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}/requirements/${reqId}`)
  await set(reqRef, newRequirement)
  
  return reqId
}

/**
 * Delete a business record
 */
export async function deleteBusinessRecord(businessId: string): Promise<void> {
  const businessRef = ref(realtimeDb, `${CREATION_PATH}/${businessId}`)
  await remove(businessRef)
}

/**
 * Check if submitted requirements update previously rejected ones
 */
export async function areRequirementsUpdatingRejected(
  businessId: string,
  submittedRequirements: Array<{ id: string; name: string }>
): Promise<boolean> {
  // Retrieve the existing business record
  const existingBusiness = await getBusinessById(businessId);

  if (!existingBusiness) {
    throw new Error(`Business with ID ${businessId} not found.`);
  }

  // Extract existing requirements
  const existingRequirements = existingBusiness.requirements;

  // Check if any rejected requirement is being updated
  return submittedRequirements.some((submittedReq) => {
    const existingReq = existingRequirements.find((req) => req.id === submittedReq.id);
    return existingReq && existingReq.status === "rejected";
  });
}
