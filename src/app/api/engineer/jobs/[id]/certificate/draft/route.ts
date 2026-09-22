import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import { saveCertificateDraft } from "@/lib/documents/certificate-drafts";

/**
 * Saving the record the engineer is part-way through.
 *
 * `PUT`, because it replaces the draft for this job rather than adding one —
 * there is only ever one, and the unique index says so.
 *
 * **The revision is the whole of the concurrency story.** The client sends the
 * revision its sheet was built from; a save based on an older one is refused
 * with `409` and the current draft, rather than applied. A phone left open in
 * a van cannot replace what was done afterwards on a tablet, and neither one
 * silently loses work: the refusal carries what is actually stored.
 *
 * **Same-origin is checked explicitly**, as the reconciliation endpoint is,
 * and for the same reason: Auth.js sets `SameSite=Lax`, so a cross-site POST
 * would not carry the session anyway — but a protection that exists only as a
 * cookie attribute set by a library disappears silently the day that default
 * changes, and nothing in this handler would look any different.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkSameOrigin(request).ok) {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  let session;
  try {
    session = await requireEngineerOrThrow();
  } catch {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "That save could not be read." },
      { status: 400, headers: NO_STORE },
    );
  }

  const payload = (body ?? {}) as { fields?: unknown; revision?: unknown };
  /*
    An absent or unreadable revision is treated as 0 — "I believe there is no
    draft yet" — which is the safe reading: if one does exist, the save is
    refused as a conflict rather than overwriting it.
  */
  const expectedRevision =
    typeof payload.revision === "number" && Number.isInteger(payload.revision)
      ? Math.max(0, payload.revision)
      : 0;

  const result = await saveCertificateDraft({
    session,
    jobId: id,
    fields: payload.fields,
    expectedRevision,
  });

  if (!result.ok) {
    if (result.conflict) {
      return NextResponse.json(
        {
          error: result.error,
          conflict: true,
          draft: {
            fields: result.draft.fields,
            revision: result.draft.revision,
            updatedAt: result.draft.updatedAt?.toISOString() ?? null,
          },
        },
        { status: 409, headers: NO_STORE },
      );
    }
    /*
      404 for anything the caller is not entitled to, so a job that is not
      theirs and a job that does not exist are one answer. A refusal that
      names a lifecycle state is about a job they can already see.
    */
    const status = result.error.startsWith("That job") ? 404 : 400;
    return NextResponse.json(
      { error: result.error },
      { status, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      revision: result.revision,
      updatedAt: result.updatedAt.toISOString(),
    },
    { status: 200, headers: NO_STORE },
  );
}
