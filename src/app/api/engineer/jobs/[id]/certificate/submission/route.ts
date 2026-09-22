import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import { submitCertificateDraft } from "@/lib/documents/certificate-drafts";
import { revalidatePath } from "next/cache";

/**
 * The finished record, straight into the existing awaiting-review state.
 *
 * The generator draws the PDF it has always drawn and posts the bytes here
 * instead of handing them to the browser's download machinery. Everything
 * after that is the path the manual upload has always taken: the bytes are
 * checked from the bytes, stored in the private document store before any row
 * is written, and recorded as a document awaiting review.
 *
 * **It issues nothing.** No certificate row, no compliance date, no email. An
 * administrator opens it, reads it and releases it, exactly as before.
 *
 * **`submissionKey` is what makes a double tap safe.** The same key returns
 * the document the first attempt produced. Without it, a retry after an
 * uncertain response is a second certificate for somebody to choose between.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "That submission could not be read. Try again." },
      { status: 400, headers: NO_STORE },
    );
  }

  const file = form.get("pdf");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "No certificate was attached to that submission." },
      { status: 400, headers: NO_STORE },
    );
  }

  const submissionKey = String(form.get("submissionKey") ?? "");
  const drawnFrom = Number(form.get("revision"));
  const drawnFromRevision = Number.isInteger(drawnFrom) ? drawnFrom : undefined;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "That certificate could not be read. Try again." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await submitCertificateDraft({
    session,
    jobId: id,
    bytes,
    filename: file.name,
    submissionKey,
    drawnFromRevision,
  });

  if (!result.ok) {
    const status = result.error.startsWith("That job") ? 404 : 400;
    return NextResponse.json(
      { error: result.error, missing: result.missing ?? [] },
      { status, headers: NO_STORE },
    );
  }

  /*
    Both screens that now show something new: the engineer's job page gains an
    "awaiting review" state, and the administrator's gains a document to read.
    Revalidating here rather than in the browser means the office sees it
    without anybody refreshing anything.
  */
  revalidatePath(`/engineer/jobs/${id}`);
  revalidatePath(`/admin/jobs/${id}`);

  return NextResponse.json(
    {
      ok: true,
      documentId: result.documentId,
      replayed: result.replayed,
      message: result.message,
    },
    { status: 200, headers: NO_STORE },
  );
}
