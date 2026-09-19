import "server-only";

import { del, get, put } from "@vercel/blob";

/**
 * The Vercel Blob adapter.
 *
 * Kept apart from `documents.ts` so the driver is a seam rather than a
 * branch: everything the application does goes through `putDocument` /
 * `getDocument` / `deleteDocument`, and this file is the only place that
 * knows what a Blob store is.
 *
 * **`access: "private"` is passed on every call and is not configurable.**
 * There is no option, no environment variable and no fallback that makes a
 * certificate public. A public blob is a URL that works for anybody who
 * ever sees it, forever, with no way to withdraw it — which is the opposite
 * of what a document about somebody's property needs. If a call ever fails
 * because private access is unavailable, the upload fails; it does not
 * quietly become public.
 *
 * The authorisation boundary stays where it was: `/api/documents/[id]`
 * re-derives the caller's permission from the database and streams the
 * bytes. The blob URL never leaves the server and is never rendered.
 *
 * Reference: the SDK's own types in `@vercel/blob` (v2.8), and
 * https://vercel.com/docs/vercel-blob/using-blob-sdk.
 */

/**
 * Everything this application stores lives under one prefix.
 *
 * It means a store shared with anything else stays legible, and it makes
 * the cleanup path below able to say "this is one of ours" from the
 * pathname alone.
 */
export const BLOB_PREFIX = "certificates/";

export type BlobOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** The pathname a key is stored at. Keys are opaque; this adds no meaning. */
export function blobPathname(key: string): string {
  return `${BLOB_PREFIX}${key}`;
}

function describe(error: unknown): string {
  /*
    The SDK throws typed errors. Their messages are safe to keep — they
    describe the store and the request, never the document — but they are
    not shown to a person; the caller substitutes its own wording. This is
    for the audit line and the server log.
  */
  if (error instanceof Error) return error.name;
  return "unknown";
}

export async function blobPut(
  key: string,
  bytes: Uint8Array,
  token: string,
): Promise<BlobOutcome<{ pathname: string }>> {
  try {
    const result = await put(blobPathname(key), Buffer.from(bytes), {
      // Not a variable. See the note at the top of this file.
      access: "private",
      contentType: "application/pdf",
      /*
        The key is already random and unique, so a suffix would only make
        the pathname unpredictable to us as well. `allowOverwrite` stays
        false: two documents can never collide on a random 48-hex key, and
        if they somehow did, failing is right — an overwrite would destroy
        a certificate.
      */
      addRandomSuffix: false,
      allowOverwrite: false,
      token,
    });
    return { ok: true, value: { pathname: result.pathname } };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function blobGet(
  key: string,
  token: string,
): Promise<BlobOutcome<Uint8Array>> {
  try {
    const found = await get(blobPathname(key), {
      access: "private",
      /*
        Straight from origin. A certificate is read rarely and correctness
        matters more than a cache hit — and a stale read after a correction
        would hand somebody the wrong version of a safety record.
      */
      useCache: false,
      token,
    });

    if (!found || found.statusCode === 304 || !found.stream) {
      return { ok: false, error: "not_found" };
    }

    const chunks: Uint8Array[] = [];
    // The SDK returns a web stream. Buffered here because the route needs
    // the whole body anyway to set a length and audit the read.
    const reader = found.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: bytes };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/**
 * Removes one object, by the pathname this module owns.
 *
 * Only ever called to clean up a blob whose database row failed to write —
 * see `putDocument`'s caller. It takes a single key, never a prefix and
 * never a list, so there is no shape of call that could remove a released
 * certificate or somebody else's object.
 */
export async function blobDelete(
  key: string,
  token: string,
): Promise<BlobOutcome<null>> {
  try {
    await del(blobPathname(key), { token });
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}
