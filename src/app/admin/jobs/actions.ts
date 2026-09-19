"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { getDb } from "@/lib/db/client";
import { activities, jobs, outboundEmails } from "@/lib/db/schema";
import { invitationRow } from "@/lib/notifications/kinds";
import { assignEngineer, unassignEngineer } from "@/lib/jobs/work-actions";
import {
  queueCertificateEmail,
  releaseCertificate,
  requeueCertificateEmail,
} from "@/lib/documents/certificates";
import { isoDateInZone } from "@/lib/booking/time";
import { bookingConfig } from "@/lib/booking/config";
import { eq } from "drizzle-orm";

/**
 * Sending a tenant their link again.
 *
 * A deliberate act by a person, not a retry: the worker already retries a
 * delivery that failed. This is for the cases retrying cannot fix — the
 * address was wrong and has been corrected, the tenant deleted it, the link
 * expired before they got to it.
 *
 * It queues a **new** intent rather than reviving the old row, because the two
 * are different facts: "we tried five times and could not reach them" is worth
 * keeping next to "and then we tried again on Tuesday". The worker mints the
 * link's token when it sends.
 *
 * A server action is a public HTTP endpoint with a generated name, so this
 * starts with `requireAdmin()` against a verified session before it looks at
 * anything. It is audited, because it causes an email to a tenant.
 */

export type ResendState = { message?: string; error?: string };

/** The statuses where a tenant still has something to act on. */
const INVITABLE = ["tenant_outreach", "awaiting_tenant", "scheduled"];

export async function resendInvitationAction(
  _previous: ResendState,
  form: FormData,
): Promise<ResendState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const db = getDb();
  if (!db) return { error: "The database is not available." };

  const [job] = await db
    .select({
      id: jobs.id,
      reference: jobs.reference,
      lifecycleStatus: jobs.lifecycleStatus,
      propertyId: jobs.propertyId,
      agentOrganisationId: jobs.agentOrganisationId,
      tenancyId: jobs.tenancyId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) return { error: "That job could not be found." };

  if (!INVITABLE.includes(job.lifecycleStatus)) {
    return {
      error:
        "This job is finished, so there is nothing for a tenant to book. No invitation was queued.",
    };
  }

  if (!job.tenancyId) {
    return {
      error:
        "This job has no tenant on file, so there is nobody to send a link to.",
    };
  }

  const issuedAt = new Date();

  try {
    await db.batch([
      db.insert(outboundEmails).values(invitationRow({ jobId, issuedAt })),
      db.insert(activities).values({
        jobId,
        propertyId: job.propertyId,
        agentOrganisationId: job.agentOrganisationId,
        kind: "invitation.resent",
        actor: `user:${session.user.id}`,
        // No token, no address. The act, not its contents.
        detail: { issuedAt: issuedAt.toISOString() },
      }),
    ]);
  } catch {
    return { error: "The invitation could not be queued. Please try again." };
  }

  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "invitation.resent",
    subjectType: "job",
    subjectId: jobId,
    // Never the token and never the tenant's address.
    detail: { reference: job.reference },
  });

  revalidatePath(`/admin/jobs/${jobId}`);
  return {
    message:
      "Queued. It will be sent on the next run of the outbox, with a fresh link.",
  };
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Putting an engineer on a job, and taking them off again.
 *
 * A server action is a public HTTP endpoint with a generated name, so both of
 * these start with `requireAdmin()` against a verified session before they
 * look at anything the form sent. Everything else — the job's status, who is
 * on it, whether the move is legal — is re-read in `work-actions.ts` from the
 * row rather than taken from the request. The form contributes two ids and
 * nothing more.
 */

export type AssignState = { message?: string; error?: string };

export async function assignEngineerAction(
  _previous: AssignState,
  form: FormData,
): Promise<AssignState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  const engineerId = String(form.get("engineerId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await assignEngineer({ session, jobId, engineerId });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/admin/jobs/${jobId}`);
  revalidatePath("/admin/jobs");
  return { message: result.message };
}

export async function unassignEngineerAction(
  _previous: AssignState,
  form: FormData,
): Promise<AssignState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "No job was named." };

  const result = await unassignEngineer({ session, jobId });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/admin/jobs/${jobId}`);
  revalidatePath("/admin/jobs");
  return { message: result.message };
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/**
 * Releasing a reviewed certificate, and sending it.
 *
 * Both start with `requireAdmin()` against a verified session, and both
 * re-derive everything else in `documents/certificates.ts` — including that
 * the caller's scope is unfiltered, because an agency may read its own
 * released certificates and may never release or send one.
 */

export type ReleaseActionState = {
  message?: string;
  error?: string;
  errors?: Record<string, string>;
};

export async function releaseCertificateAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireAdmin();

  const jobId = String(form.get("jobId") ?? "");
  const documentId = String(form.get("documentId") ?? "");
  if (!jobId || !documentId) return { error: "Nothing was named to release." };

  const result = await releaseCertificate({
    session,
    jobId,
    documentId,
    details: {
      certificateNumber: form.get("certificateNumber"),
      inspectionDate: form.get("inspectionDate"),
      nextDueDate: form.get("nextDueDate"),
      correctionReason: form.get("correctionReason"),
    },
    // The server's day, not the browser's.
    today: isoDateInZone(new Date(), bookingConfig.timeZone),
  });

  if (!result.ok) return { error: result.error, errors: result.errors };

  revalidatePath(`/admin/jobs/${jobId}`);
  revalidatePath(`/portal/jobs/${jobId}`);
  return { message: result.message };
}

export async function queueCertificateEmailAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireAdmin();

  const certificateId = String(form.get("certificateId") ?? "");
  const jobId = String(form.get("jobId") ?? "");
  if (!certificateId) return { error: "No certificate was named." };

  /*
    Whatever boxes were ticked. Unrecognised values are dropped in
    `queueCertificateEmail`, which checks each against the closed list of
    recipient roles rather than trusting the form.
  */
  const recipients = form.getAll("recipients").map(String);

  const result = await queueCertificateEmail({
    session,
    certificateId,
    recipients,
  });
  if (!result.ok) return { error: result.error };

  if (jobId) revalidatePath(`/admin/jobs/${jobId}`);
  return { message: result.message };
}

export async function requeueCertificateEmailAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireAdmin();

  const certificateId = String(form.get("certificateId") ?? "");
  const jobId = String(form.get("jobId") ?? "");
  if (!certificateId) return { error: "No certificate was named." };

  const result = await requeueCertificateEmail({
    session,
    certificateId,
    recipient: form.get("recipient"),
  });
  if (!result.ok) return { error: result.error };

  if (jobId) revalidatePath(`/admin/jobs/${jobId}`);
  return { message: result.message };
}
