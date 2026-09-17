"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent, requireCapability } from "@/lib/auth/session";
import { createAgentJob } from "@/lib/jobs/create-agent-job";
import { isProductId } from "@/lib/booking/products";
import { MAX_APPLIANCES } from "@/lib/booking/pricing";
import type { FieldErrors } from "@/lib/portfolio/validation";

/**
 * Booking work.
 *
 * A server action is a public HTTP endpoint with a generated name, so this
 * verifies the session before it reads a single field — and the organisation
 * it writes is the one `requireAgent()` returned, never anything submitted.
 *
 * What the form is allowed to decide is deliberately small: which property,
 * which service, how many appliances, by when, and a note. Price, reference,
 * status, scheduling method, organisation and every snapshot are derived in
 * `createAgentJob`, which has no parameter for any of them.
 */

export type ActionState = { errors?: FieldErrors; message?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function bookWorkAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "job:create");

  const propertyId = String(form.get("propertyId") ?? "");
  const submissionKey = String(form.get("submissionKey") ?? "");
  const productId = String(form.get("productId") ?? "");
  const timing = String(form.get("timing") ?? "asap");
  const completeByDate = String(form.get("completeByDate") ?? "").trim();
  const notes = String(form.get("notes") ?? "").trim();

  const errors: FieldErrors = {};

  // The registry decides what is bookable. An unknown id is not a service.
  if (!isProductId(productId)) errors.productId = "Choose a service.";

  const requestedAsap = timing !== "deadline";
  if (!requestedAsap) {
    if (!ISO_DATE.test(completeByDate)) {
      errors.completeByDate = "Enter the date you need it completed by.";
    } else if (completeByDate < todayIso()) {
      errors.completeByDate = "That date has already passed.";
    }
  }

  const applianceCount = Number(form.get("applianceCount") ?? 1);
  if (
    !Number.isInteger(applianceCount) ||
    applianceCount < 1 ||
    applianceCount > MAX_APPLIANCES
  ) {
    errors.applianceCount = `Enter a number between 1 and ${MAX_APPLIANCES}.`;
  }

  if (!submissionKey) {
    // Without one, a double click would create two jobs.
    errors.form = "Please reload the page and try again.";
  }

  if (Object.keys(errors).length > 0) return { errors };
  if (!isProductId(productId)) return { errors };

  const result = await createAgentJob(
    session.organisationId,
    {
      propertyId,
      productId,
      applianceCount,
      requestedAsap,
      completeByDate: requestedAsap ? null : completeByDate,
      notes: notes || null,
      submissionKey,
    },
    session.user.id,
  );

  // "Not yours" and "no such property" are the same answer, deliberately.
  if (result.status === "not_found") return { message: "Not found." };
  if (result.status === "not_configured" || result.status === "failed") {
    return { message: "That job could not be created. Please try again." };
  }

  revalidatePath("/portal/jobs");
  revalidatePath(`/portal/portfolio/${propertyId}`);
  // A retry lands on the job it already created rather than making a second.
  redirect(`/portal/jobs/${result.jobId}`);
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
