import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";
import { getJobForPrefill } from "@/lib/jobs/engineer-queries";
import { getBusinessIdentity } from "@/lib/settings/store";
import {
  buildCp12Payload,
  cp12PrefillFilename,
  type Cp12PrefillFacts,
} from "@/lib/jobs/cp12-prefill";
import { recordAudit } from "@/lib/audit/record";

/**
 * The CP12 prefill payload, as a download.
 *
 * The transport decision from `docs/CP12_PREFILL_MAPPING.md`, and the reasons
 * are worth restating where the code is:
 *
 * - **Nothing private is in the URL.** The job id is an opaque UUID in the
 *   path; there is no query string, and no name, address or postcode appears
 *   anywhere a browser history, a referrer or a proxy log would keep.
 * - **Authorisation is decided here, against the row.** The audience guard
 *   comes first, then the read is scoped by assignment — an engineer who is
 *   not on this job gets exactly the answer they would get for a job that
 *   does not exist. **A booking reference authorises nothing**; it is not
 *   even accepted as an identifier.
 * - **An attachment, not a page.** The engineer saves a file and hands it to
 *   the generator. Nothing is rendered, so nothing is cached, indexed or
 *   screenshotted by a preview.
 *
 * It is a read. It writes no job, sends no message and calls no external
 * service — the only write is the audit line, because a file of customer
 * details leaving the application is worth being able to account for.
 */

export const dynamic = "force-dynamic";

/** Says nothing about whether the job exists. */
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
    // The audience guard. A 401 rather than a redirect: this is a fetch, and
    // handing it an HTML login page with a 200 on it is how that gets parsed
    // as success.
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id } = await params;

  /*
    Scoped by assignment inside the query, so an out-of-scope row is never
    loaded rather than loaded and then rejected.
  */
  const job = await getJobForPrefill(session.scope, id);
  if (!job) return notFound();

  /*
    Empty until BSCJ fills it in, and that is the correct behaviour: the
    installer block arrives blank and the payload says why, rather than
    carrying a value invented here.
  */
  const identity = await getBusinessIdentity();

  const facts: Cp12PrefillFacts = {
    reference: job.reference,
    property: {
      houseOrName: job.houseOrName,
      street: job.street,
      town: job.town,
      postcode: job.postcode,
    },
    tenancy: job.tenantName || job.tenantPhone
      ? { name: job.tenantName, phone: job.tenantPhone }
      : null,
    customer: {
      name: job.customerName,
      company: job.customerCompany,
      phone: job.customerPhone,
    },
    /*
      The agency is read by the query and deliberately not passed on. The
      certificate is issued to the customer, and an agency's trading or
      billing details are not theirs — see `cp12-prefill.ts`.
    */
    engineerName: job.engineerName,
    business: {
      displayName: identity.displayName,
      addressLines: identity.addressLines,
      postcode: identity.postcode,
      phone: identity.phone,
      gasSafeNumber: identity.gasSafeNumber,
    },
  };

  const payload = buildCp12Payload(facts, new Date());

  /*
    A file of customer details has left the application. Who took it, for
    which job, and when — never the contents.
  */
  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "cp12.prefill_downloaded",
    subjectType: "job",
    subjectId: id,
    detail: { reference: job.reference, fields: Object.keys(payload.fields).length },
  });

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${cp12PrefillFilename(job.reference)}"`,
      // It is customer data. Nothing may hold a copy on the way past.
      "Cache-Control": "no-store, max-age=0",
      /*
        No referrer header is set here on purpose: the framework's own
        policy applies, and there is nothing in this URL to leak. The path
        is a job UUID and there is no query string — which is the actual
        defence, rather than a header that has to be trusted.
      */
      "X-Content-Type-Options": "nosniff",
    },
  });
}
