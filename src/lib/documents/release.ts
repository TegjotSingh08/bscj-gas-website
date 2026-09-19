/**
 * What has to be true before a certificate is released, and to whom.
 *
 * Release is the step where a PDF stops being a file somebody uploaded and
 * becomes a record an agency can see and a customer can be sent. Three
 * things shape the rules below:
 *
 * 1. **A generated PDF is not a reviewed one.** Six assessed outcomes and a
 *    successful export mean the engineer finished the form. They do not mean
 *    anybody has looked at it. Nothing here treats an upload as an approval.
 * 2. **Nothing is invented.** The certificate number is typed by the person
 *    releasing it, because no numbering scheme exists. The inspection date
 *    and the next due date are typed too — the renewal rule in
 *    `compliance/renewal.ts` is confirmed, and this phase deliberately does
 *    not apply it, so the date on the record is the date a person put there
 *    and not one derived on their behalf.
 * 3. **An issued certificate is never overwritten.** Releasing again over an
 *    existing one is a correction: a new version, a reason, and the old row
 *    kept.
 *
 * Pure and dependency-free.
 */

import { parseCalendarDate } from "@/lib/compliance/renewal";

/**
 * Who a released certificate may be emailed to.
 *
 * Roles, not addresses. The address is resolved from the database — shown
 * to the administrator before they send, and resolved again by the worker
 * when it sends — so no address is ever carried in a queue row or a URL.
 *
 * **The tenant is deliberately absent.** A tenant reaches this system
 * through a scheduling link, which is a token for choosing an appointment
 * and has never been an identity. Emailing them a compliance document is a
 * decision about who is entitled to one, and nobody has made it.
 */
export const CERTIFICATE_RECIPIENTS = ["agent", "customer"] as const;
export type CertificateRecipient = (typeof CERTIFICATE_RECIPIENTS)[number];

export function isCertificateRecipient(
  value: unknown,
): value is CertificateRecipient {
  return (
    typeof value === "string" &&
    (CERTIFICATE_RECIPIENTS as readonly string[]).includes(value)
  );
}

/** How long a certificate number may be. A label, not a paragraph. */
export const MAX_CERTIFICATE_NUMBER = 40;
/** A correction has to say why. Long enough for a sentence. */
export const MAX_CORRECTION_REASON = 500;

export type ReleaseInput = {
  certificateNumber: unknown;
  inspectionDate: unknown;
  nextDueDate: unknown;
  correctionReason: unknown;
};

export type ReleaseDetails = {
  certificateNumber: string;
  inspectionDate: string;
  nextDueDate: string;
  correctionReason: string | null;
};

export type ReleaseCheck =
  | { ok: true; details: ReleaseDetails }
  | { ok: false; errors: Record<string, string> };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Checks what the administrator typed.
 *
 * Every field is required and every one is theirs. `isCorrection` is
 * decided from the database — whether this job already has an issued
 * certificate — never from the form, so a correction cannot be made to look
 * like a first issue by omitting a field.
 */
export function checkRelease(
  input: ReleaseInput,
  options: { isCorrection: boolean; today?: string },
): ReleaseCheck {
  const errors: Record<string, string> = {};

  const certificateNumber = text(input.certificateNumber);
  if (!certificateNumber) {
    errors.certificateNumber =
      "Enter the certificate number exactly as it appears on the PDF.";
  } else if (certificateNumber.length > MAX_CERTIFICATE_NUMBER) {
    errors.certificateNumber = `That is longer than ${MAX_CERTIFICATE_NUMBER} characters.`;
  }

  const inspectionDate = text(input.inspectionDate);
  const inspection = parseCalendarDate(inspectionDate);
  if (!inspectionDate) {
    errors.inspectionDate = "Enter the date the inspection was carried out.";
  } else if (!inspection) {
    errors.inspectionDate = "That is not a real date.";
  } else if (options.today && inspectionDate > options.today) {
    // A certificate cannot record an inspection that has not happened.
    errors.inspectionDate = "That date is in the future.";
  }

  const nextDueDate = text(input.nextDueDate);
  const due = parseCalendarDate(nextDueDate);
  if (!nextDueDate) {
    errors.nextDueDate =
      "Enter the next due date exactly as it appears on the PDF.";
  } else if (!due) {
    errors.nextDueDate = "That is not a real date.";
  } else if (inspection && nextDueDate <= inspectionDate) {
    errors.nextDueDate = "The next due date must be after the inspection date.";
  }

  const correctionReason = text(input.correctionReason);
  if (options.isCorrection && !correctionReason) {
    errors.correctionReason =
      "This job already has an issued certificate. Say what is being corrected.";
  } else if (correctionReason.length > MAX_CORRECTION_REASON) {
    errors.correctionReason = `That is longer than ${MAX_CORRECTION_REASON} characters.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    details: {
      certificateNumber,
      inspectionDate,
      nextDueDate,
      correctionReason: correctionReason || null,
    },
  };
}

/**
 * Which jobs may carry a certificate upload.
 *
 * The visit has to have happened. A certificate for a job nobody has
 * attended is a certificate for an inspection that did not take place, and
 * that is the one thing this whole surface exists to make hard.
 *
 * `remedial_required` is included on purpose: the inspection happened and
 * produced a record; what is outstanding is the work that follows it.
 */
const UPLOADABLE_STATUSES = ["in_progress", "remedial_required", "completed"];

export function canUploadCertificate(lifecycleStatus: string): boolean {
  return UPLOADABLE_STATUSES.includes(lifecycleStatus);
}

export function uploadRefusal(lifecycleStatus: string): string | null {
  if (canUploadCertificate(lifecycleStatus)) return null;
  if (lifecycleStatus === "cancelled") return "This job was cancelled.";
  return "The visit has not started yet, so there is nothing to certificate.";
}

/**
 * Whether a document may be released.
 *
 * Deliberately not "has six outcomes" or "is a valid PDF". Those are
 * properties of a file. This is a person saying they have read it.
 */
export type ReleaseState = {
  /** A stored, unreleased document exists for this job. */
  hasDocument: boolean;
  /** The job already has an issued certificate — releasing is a correction. */
  hasIssuedCertificate: boolean;
};

export function canRelease(state: ReleaseState): boolean {
  return state.hasDocument;
}
