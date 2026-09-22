import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";
import { getJobForPrefill } from "@/lib/jobs/engineer-queries";
import { getBusinessIdentity } from "@/lib/settings/store";
import { buildCp12Payload, type Cp12PrefillFacts } from "@/lib/jobs/cp12-prefill";
import { loadCertificateDraft } from "@/lib/documents/certificate-drafts";
import { canUploadCertificate } from "@/lib/documents/release";

/**
 * Everything the connected generator needs to open on a job, in one request.
 *
 * The prefill and the saved draft together, because they are only useful
 * together: the generator applies the prefill to a blank sheet and then lays
 * the draft over it, so a value the engineer has already typed is never
 * replaced by an administrative one. Two requests would let the page render
 * between them and show a sheet that is briefly wrong.
 *
 * **Nothing here is decided by the caller.** The job id in the path is a
 * lookup key; the read is scoped by assignment inside the query, and the
 * draft's own module re-derives access from the job row. An engineer who is
 * not on this job gets the answer they would get for a job that does not
 * exist — the same 404, with nothing in it that distinguishes the two.
 *
 * **No file leaves the application.** This is the replacement for the
 * downloaded prefill: same payload, same allow-list, delivered to the page
 * that asked for it instead of to the device's Downloads folder.
 */

export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireEngineerOrThrow();
  } catch {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id } = await params;

  const loaded = await loadCertificateDraft({ session, jobId: id });
  if (!loaded.ok) return notFound();

  /* Scoped by assignment inside the query, as the download always was. */
  const job = await getJobForPrefill(session.scope, id);
  if (!job) return notFound();

  const identity = await getBusinessIdentity();

  const facts: Cp12PrefillFacts = {
    reference: job.reference,
    property: {
      houseOrName: job.houseOrName,
      street: job.street,
      town: job.town,
      postcode: job.postcode,
    },
    tenancy:
      job.tenantName || job.tenantPhone
        ? { name: job.tenantName, phone: job.tenantPhone }
        : null,
    customer: {
      name: job.customerName,
      company: job.customerCompany,
      phone: job.customerPhone,
    },
    engineerName: job.engineerName,
    business: {
      displayName: identity.displayName,
      addressLines: identity.addressLines,
      postcode: identity.postcode,
      phone: identity.phone,
      gasSafeNumber: identity.gasSafeNumber,
    },
  };

  return NextResponse.json(
    {
      job: {
        id: loaded.job.id,
        reference: loaded.job.reference,
        /*
          Whether this job can carry a certificate at all. The generator uses
          it to explain rather than to decide — every write re-checks it.
        */
        canSubmit: canUploadCertificate(loaded.job.lifecycleStatus),
      },
      prefill: buildCp12Payload(facts, new Date()),
      draft: {
        fields: loaded.draft.fields,
        revision: loaded.draft.revision,
        updatedAt: loaded.draft.updatedAt?.toISOString() ?? null,
        submittedAt: loaded.draft.submittedAt?.toISOString() ?? null,
      },
    },
    {
      status: 200,
      headers: {
        // Customer details. Nothing may hold a copy on the way past.
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
