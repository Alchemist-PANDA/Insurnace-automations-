import type { ScoringModel } from "../scoring.js";

/**
 * Roofing / HVAC vertical template (plan: PLAN M4/M6, blueprint §3).
 * The first supported vertical. Ships as data; tenants override.
 */

export const ROOFING_HVAC_SERVICES = [
  "roof_replacement",
  "roof_repair",
  "storm_damage",
  "inspection",
  "hvac_install",
  "hvac_repair",
  "maintenance",
] as const;
export type RoofingHvacService = (typeof ROOFING_HVAC_SERVICES)[number];

export const roofingHvacScoringModel: ScoringModel = {
  version: "roofing-hvac@1",
  caps: { fit: 35, intent: 30, urgency: 20, engagement: 15 },
  bands: { hot: 80, qualified: 55, nurture: 25 },
  rules: [
    // Fit (0-35)
    { key: "service_area_match", category: "fit", points: 15, when: "insideServiceArea", label: "service-area match" },
    { key: "eligible_service", category: "fit", points: 10, when: "eligibleService", label: "eligible service" },
    { key: "eligible_property", category: "fit", points: 5, when: "eligiblePropertyType", label: "valid property type" },
    { key: "valid_phone", category: "fit", points: 3, when: "validPhone", label: "valid phone" },
    { key: "valid_email", category: "fit", points: 2, when: "validEmail", label: "valid email" },
    // Intent (0-30)
    { key: "asked_pricing", category: "intent", points: 8, when: "askedPricing", label: "asked about pricing" },
    { key: "requested_appointment", category: "intent", points: 12, when: "requestedAppointment", label: "requested appointment" },
    { key: "clear_project", category: "intent", points: 6, when: "hasClearProject", label: "clear project" },
    { key: "replied_quickly", category: "intent", points: 2, when: "repliedQuickly", label: "replied quickly" },
    { key: "provided_detail", category: "intent", points: 2, when: "providedDetail", label: "provided detail" },
    // Urgency (0-20)
    { key: "active_emergency", category: "urgency", points: 20, when: "activeEmergency", label: "active leak/emergency" },
    { key: "within_30_days", category: "urgency", points: 10, when: "within30Days", label: "needed within 30 days" },
    { key: "insurance_deadline", category: "urgency", points: 8, when: "insuranceDeadline", label: "insurance deadline" },
    // Engagement (0-15)
    { key: "replied_sms", category: "engagement", points: 6, when: "repliedToSms", label: "replied to SMS" },
    { key: "clicked_booking", category: "engagement", points: 5, when: "clickedBookingLink", label: "clicked booking link" },
    { key: "answered_qualification", category: "engagement", points: 4, when: "answeredQualification", label: "answered qualification" },
    { key: "called_business", category: "engagement", points: 5, when: "calledBusiness", label: "called the business" },
    { key: "opened_email", category: "engagement", points: 2, when: "openedEmail", label: "opened email" },
    // Negatives
    { key: "neg_duplicate", category: "negative", points: -30, when: "isDuplicate", label: "duplicate" },
    { key: "neg_outside_area", category: "negative", points: -40, when: "outsideServiceArea", label: "outside service area" },
    { key: "neg_job_seeker", category: "negative", points: -40, when: "jobSeekerOrStudent", label: "job seeker/student" },
    { key: "neg_supplier", category: "negative", points: -40, when: "supplierSolicitation", label: "supplier solicitation" },
    { key: "neg_invalid_phone", category: "negative", points: -20, when: "invalidPhone", label: "invalid phone" },
    { key: "neg_abusive", category: "negative", points: -50, when: "abusiveContent", label: "abusive content" },
    { key: "neg_spam", category: "negative", points: -50, when: "obviousSpam", label: "obvious spam" },
    { key: "neg_no_shows", category: "negative", points: -20, when: "repeatedNoShows", label: "repeated no-shows" },
  ],
};

/** Ordered qualification schema for roofing/HVAC (plan: conversation-engine §6). */
export const roofingHvacQualificationSchema = {
  key: "roofing-hvac@1",
  fields: [
    { key: "service", required: true, question: "Are you looking at a roof replacement, a repair, storm damage, or an HVAC issue?" },
    { key: "urgency", required: true, question: "Is this an active emergency like a leak, or are you planning ahead?" },
    { key: "property_type", required: true, question: "Is this for a single-family home, or another type of property?" },
    { key: "location_confirmed", required: true, question: "What city is the property in?" },
    { key: "insurance_claim", required: false, question: "Are you planning to file an insurance claim for this?" },
    { key: "timeline", required: false, question: "What's your ideal timeline for getting this done?" },
    { key: "appointment_intent", required: true, question: "Would you like to book a free inspection?" },
  ],
} as const;

/** Default first-touch SMS template. Single opening question, business identity. */
export const roofingHvacFirstTouchTemplate =
  "Hi {{firstName}}, this is {{agentName}} from {{businessName}}. " +
  "I saw your request about {{serviceLabel}} in {{city}}. " +
  "Are you dealing with active leaking, storm damage, or planning a future project?";
