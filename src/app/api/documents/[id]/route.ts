import { NextResponse } from "next/server";

import { currentSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { readDocumentFor } from "@/lib/documents/certificates";
import { safeDocumentFilename } from "@/lib/documents/validate";

/**
 * A certificate PDF, to somebody who has proved they may have it.
 *
 * The one way a stored document is ever read. There is no public URL, no
 * signed link and no token — `document.blob_key` never leaves the server
 * and never appears in a page.
 *
 * **The permission is re-derived here, per request, from the database.**
 * `readDocumentFor` decides it from the row: BSCJ staff, the engineer the
 * job is assigned to, or the owning agency once it has been released.
 * Nothing else. A tenant's scheduling session is a token for choosing an
 * appointment and grants nothing here — it is not even a session this route
 * recognises.
 *
 * Every refusal is the same 404, whether the document does not exist, is
 * not released, or belongs to another agency. Three different answers would
 * turn an id into a probe.
 *
 * **Not under `/engineer` or `/portal` on purpose.** All three audiences
 * read documents and the check is the same for each; one route with one
 * decision is easier to keep right than three that must agree.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFUSED = { "Cache-Control": "no-store" } as const;

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers: REFUSED });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  /*
    Any signed-in user of the application. Which of them may have *this*
    document is the next question, and it is answered from the row rather
    than from which surface they arrived at.
  */
  const session = await currentSession();
  if (!session) {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: REFUSED },
    );
  }

  const { id } = await params;
  const result = await readDocumentFor(session.scope, id);

  if (!result.ok) {
    if (result.status === 503) {
      /*
        The record exists and the bytes could not be read. Distinguished
        from a refusal deliberately: this is a storage fault somebody has to
        fix, and reporting it as "not found" would hide it. It says nothing
        about whose document it is — the caller already passed the
        permission check to get here.
      */
      return NextResponse.json(
        { error: "unavailable" },
        { status: 503, headers: REFUSED },
      );
    }
    return notFound();
  }

  /*
    Who read which document, and when. A certificate is a record about
    somebody's property; every read of one is worth being able to account
    for. The filename is not logged — it is the only field here that could
    carry an address.
  */
  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "document.read",
    subjectType: "document",
    subjectId: id,
    detail: { role: session.user.role },
  });

  const filename = safeDocumentFilename(result.filename, "certificate.pdf");

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      /*
        `inline`, so the browser's own viewer opens it — an engineer
        checking they uploaded the right file should not have to download
        it first. It is still a private response that nothing may keep.
      */
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      // A PDF viewer is all this is. Nothing in it should run or be framed.
      "Content-Security-Policy": "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
    },
  });
}
