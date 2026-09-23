import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/scheduling/origin";
import { signCertificateDraft } from "@/lib/documents/certificate-drafts";
import {
  describeSignatures,
  isSignatureRole,
} from "@/lib/documents/certificate-signatures";

/**
 * A mark drawn on the signature row, into the record it was drawn against.
 *
 * **Why signing is a request of its own.** It could have travelled with the
 * draft save, and that would have been wrong in three ways. A signature
 * would then be something a browser could set as a side effect of typing;
 * there would be no moment at which the server could say *this image was put
 * against these exact fields*; and the engineer would have no way to clear
 * one without saving something else. So it is separate, it names the
 * revision it is signing, and the store re-derives what the mark covers from
 * what is actually stored.
 *
 * `PUT` with `image: null` clears the box.
 *
 * **It authorises nothing and issues nothing.** Signing does not submit,
 * does not release, does not move a renewal and emails nobody. It writes an
 * image onto an unsubmitted draft the engineer already has access to, and the
 * access check is the same one every other call on this job makes — from the
 * job row, not from anything in the request.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
      { error: "That signature could not be read." },
      { status: 400, headers: NO_STORE },
    );
  }

  const payload = (body ?? {}) as {
    role?: unknown;
    image?: unknown;
    revision?: unknown;
  };

  if (!isSignatureRole(payload.role)) {
    return NextResponse.json(
      { error: "That is not a signature box on this certificate." },
      { status: 400, headers: NO_STORE },
    );
  }

  /*
    Absent is not the same as null here. `null` is a deliberate "clear this
    box"; anything else that is not a string is a malformed request, and
    guessing which one was meant would be guessing about a signature.
  */
  if (payload.image !== null && typeof payload.image !== "string") {
    return NextResponse.json(
      { error: "That signature could not be read." },
      { status: 400, headers: NO_STORE },
    );
  }

  /*
    Unlike the draft save, an unreadable revision is **not** treated as 0.
    A save based on nothing is refused by the unique index; a signature based
    on nothing would simply be a mark with no stated subject, which is the
    one thing this endpoint exists to prevent.
  */
  if (
    typeof payload.revision !== "number" ||
    !Number.isInteger(payload.revision) ||
    payload.revision < 1
  ) {
    return NextResponse.json(
      { error: "Save this record before signing it." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await signCertificateDraft({
    session,
    jobId: id,
    role: payload.role,
    dataUrl: payload.image,
    expectedRevision: payload.revision,
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
            signatures: describeSignatures(result.draft.signatures),
          },
        },
        { status: 409, headers: NO_STORE },
      );
    }
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
      signatures: describeSignatures(result.signatures),
    },
    { status: 200, headers: NO_STORE },
  );
}
