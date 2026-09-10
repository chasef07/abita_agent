import type { StaffTaskCategory } from "../../state/call-state.js";

// Entirely fictional caller statements. These are expectations, not a classifier.
export const staffTaskCases: Array<{
  id: string;
  caller: string;
  category: StaffTaskCategory;
  message: string;
}> = [
  {
    id: "expedited_glasses",
    caller:
      "Please expedite my prescription. It is a copy of my glasses prescription, not medicine.",
    category: "optical",
    message:
      "Patient requests expedited glasses prescription copy for staff review. Missing details: delivery destination.",
  },
  {
    id: "expedited_contacts",
    caller: "Please expedite sending my contact lens prescription.",
    category: "optical",
    message:
      "Patient requests expedited contact lens prescription copy. Missing details: delivery destination.",
  },
  {
    id: "expedited_medication",
    caller:
      "Please expedite my prescription. The pharmacy needs my eye drop refill.",
    category: "medication",
    message:
      "Patient requests expedited medication refill. Missing details: medication name and pharmacy.",
  },
  {
    id: "full_records",
    caller:
      "Please expedite my full medical records, not a glasses prescription.",
    category: "documentation",
    message:
      "Requester: patient. Requested: expedited full medical records. Patient: Alex Example, DOB 02/03/1990. Missing details: delivery preference and destination.",
  },
  {
    id: "appointment",
    caller:
      "I need the waitlist because none of the offered appointments work.",
    category: "appointments",
    message:
      "Patient requests waitlist follow-up after offered appointments did not work. Missing details: preferred times.",
  },
  {
    id: "pharmacy_pa",
    caller:
      "I am calling from Example Pharmacy. We are waiting on insurance approval for the patient's eye drops.",
    category: "medication",
    message:
      "Requester: Example Pharmacy. Medication prior authorization pending per caller. Missing details: medication name, plan, reference.",
  },
  {
    id: "medication_denial",
    caller:
      "My insurance denied my medication and I need the clinical team to follow up.",
    category: "medication",
    message:
      "Patient reports medication insurance denial and requests follow-up. Status is caller-reported, not verified. Missing details: medication, pharmacy, plan and reference.",
  },
  {
    id: "test_authorization",
    caller:
      "I need an update on approval for my visual field test, not my medication.",
    category: "insurance",
    message:
      "Patient requests visual field test authorization status. Missing details: plan, authorization reference and current status. No approval verified.",
  },
  {
    id: "surgery_authorization",
    caller: "My insurer needs the authorization status for cataract surgery.",
    category: "insurance",
    message:
      "Patient requests cataract surgery authorization status. Missing details: procedure date, plan and reference. No approval verified.",
  },
  {
    id: "referral_requirement",
    caller:
      "Does my insurance require a referral? I still need staff to check that.",
    category: "insurance",
    message:
      "Patient requests staff review of insurance referral requirement. Missing details: plan and visit type.",
  },
  {
    id: "send_referral",
    caller:
      "My specialist needs you to correct and resend the referral document.",
    category: "referrals",
    message:
      "Patient requests correction and resending of specialist referral. Missing details: specialist, correction and destination.",
  },
  {
    id: "imaging_order",
    caller: "Please check if the imaging center got my imaging order.",
    category: "referrals",
    message:
      "Patient requests imaging-order receipt follow-up. Missing details: imaging center and order. Receipt not verified.",
  },
  {
    id: "pre_op",
    caller:
      "I need the pre-op team to coordinate clearance before cataract surgery next month.",
    category: "pre_op",
    message:
      "Patient requests pre-op clearance coordination for cataract surgery next month. Missing details: surgery date and clearance provider.",
  },
  {
    id: "post_op",
    caller:
      "I would like the post-op team to call me about routine follow-up care after surgery last week. No new symptoms.",
    category: "post_op",
    message:
      "Patient requests post-op team callback about routine follow-up care after surgery last week; reports no new symptoms. Missing details: procedure and date.",
  },
  {
    id: "surgical_refill",
    caller:
      "After my surgery I ran out of drops. I only need a refill, not instructions.",
    category: "medication",
    message:
      "Patient requests medication refill after surgery. Missing details: medication and pharmacy. No medication advice given.",
  },
  {
    id: "surgical_scheduling",
    caller: "I only need staff to help change the surgery appointment date.",
    category: "appointments",
    message:
      "Patient requests staff assistance changing surgery appointment date. Missing details: current and desired dates.",
  },
  {
    id: "unknown_authorization",
    caller:
      "I need prior auth. I do not know whether it is medication, a visit, a procedure, testing, or a records release.",
    category: "other",
    message:
      "Caller requests prior-authorization follow-up but cannot identify its subject after clarification. Missing details: authorization subject, plan and reference.",
  },
  {
    id: "unknown_surgical_stage",
    caller:
      "I need the surgery care team, but I cannot tell you whether this is before or after surgery.",
    category: "other",
    message:
      "Caller requests surgery care follow-up; stage remains unknown after clarification. Missing details: before/after surgery stage, procedure and timing.",
  },
  {
    id: "administrative",
    caller:
      "I have an administrative question about a lost item at the office. Please send a request.",
    category: "other",
    message:
      "Patient requests staff follow-up about a lost item at the office. Missing details: item and visit date.",
  },
  {
    id: "patient_email_summary",
    caller:
      "I am the patient, Alex Example, DOB February 3, 1990, confirmed. Please email a visit summary to alex.example@example.com.",
    category: "documentation",
    message:
      "Requester: patient. Patient: Alex Example, DOB 02/03/1990 (caller-provided). Requested: visit summary. Delivery: email to alex.example@example.com. Patient email limit explained: only visit summaries, not full visit notes. For staff review; delivery not verified.",
  },
  {
    id: "patient_email_full_notes",
    caller:
      "I want my full visit notes emailed to alex.example@example.com. I understand email is limited to a visit summary; I still want staff to clarify how I can get the full notes.",
    category: "documentation",
    message:
      "Requester: patient. Patient: Alex Example, DOB 02/03/1990. Requested: full visit notes. Preferred delivery: email to alex.example@example.com. Full visit notes excluded from patient email; only visit summary permitted. Original full-notes request retained for staff clarification of an allowed delivery path.",
  },
  {
    id: "medical_office_fax",
    caller:
      "This is Example Medical requesting records for Alex Example for Doctor Rowan. Please fax to 202-555-0199.",
    category: "documentation",
    message:
      "Requester: medical office, Example Medical. Requesting doctor: Doctor Rowan. Patient: Alex Example, DOB 02/03/1990. Requested: medical records. Delivery: fax to +12025550199. No receipt or delivery verified.",
  },
  {
    id: "attorney_reported_sent",
    caller:
      "This is Example Legal. We faxed the records request and the patient authorization on September 1. Please fax the full records to 202-555-0199.",
    category: "documentation",
    message:
      "Requester: attorney office, Example Legal. Patient: Alex Example, DOB 02/03/1990. Requested: full records. Delivery: fax to +12025550199. Records request faxed: yes, September 1, caller-reported. Patient authorization faxed: yes, September 1, caller-reported. Office receipt and authorization validity unverified; staff review required.",
  },
  {
    id: "attorney_missing_authorization",
    caller:
      "This is Example Legal. We sent the records request September 1 but have not faxed the patient authorization.",
    category: "documentation",
    message:
      "Requester: attorney office, Example Legal. Requested: full records. Records request faxed: yes, September 1, caller-reported. Patient authorization faxed: no. Explained both documents must be faxed before fulfillment. Missing details: patient authorization, authorization sent date and delivery destination. Not ready for fulfillment; staff review required.",
  },
  {
    id: "attorney_missing_request",
    caller:
      "This is Example Legal. The authorization was faxed September 1, but we have not faxed the records request.",
    category: "documentation",
    message:
      "Requester: attorney office, Example Legal. Requested: full records. Records request faxed: no. Patient authorization faxed: yes, September 1, caller-reported. Explained both documents must be faxed before fulfillment. Missing details: records request, request sent date and delivery destination. Office receipt and authorization validity unverified.",
  },
  {
    id: "attorney_unknown_date",
    caller:
      "This is Example Legal. I think both documents were sent but I cannot confirm either fax or its date.",
    category: "documentation",
    message:
      "Requester: attorney office, Example Legal. Requested: records. Records request faxed: unknown. Patient authorization faxed: unknown. Fax dates: unknown. Missing details: both fax statuses and dates, requested record scope and delivery destination. No verified receipt or authorization; staff review required.",
  },
  {
    id: "patient_incomplete",
    caller:
      "I am the patient and want records. I cannot provide any more details now.",
    category: "documentation",
    message:
      "Requester: patient. Requested: records, scope unknown. Missing details: full patient name, DOB, record scope, delivery preference and destination. Caller unable to supply details; incomplete request for staff review.",
  },
];
