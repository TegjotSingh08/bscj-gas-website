import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { requireEngineerOrThrow } from "@/lib/auth/session";

/**
 * The certificate generator, served behind the session.
 *
 * It used to be a file the engineer had to find on disk and open by hand,
 * which meant a path in an instruction, a browser that would not load the
 * libraries from a `file://` origin, and — the part that made it unusable —
 * a step that assumed somebody had set the machine up. Now it is a URL
 * inside the authenticated area: sign in, open the job, press the button.
 *
 * **It is not in `public/`, deliberately.** Anything under `public/` is
 * served to anyone who knows the path. This is staff tooling and it is
 * behind `requireEngineerOrThrow()` like every other engineer surface.
 *
 * **Three files, named explicitly.** The map below is the whole of what this
 * route can serve. It does not join a request path onto a directory and hope
 * — there is no traversal to defend against when `../../.env` simply is not
 * a key in an object.
 *
 * The generator still holds job details only in the browser, in
 * `localStorage`, exactly as it always has. This route serves the
 * application, never a job.
 */

export const dynamic = "force-dynamic";
/* Node, not edge: it reads files from the deployment. */
export const runtime = "nodejs";

/** The only paths this route will serve, and what each one is. */
const SERVABLE: Record<string, { file: string; type: string; immutable: boolean }> = {
  "": {
    file: "index.html",
    type: "text/html; charset=utf-8",
    immutable: false,
  },
  "lib/html2canvas.min.js": {
    file: "lib/html2canvas.min.js",
    type: "text/javascript; charset=utf-8",
    immutable: true,
  },
  "lib/jspdf.umd.min.js": {
    file: "lib/jspdf.umd.min.js",
    type: "text/javascript; charset=utf-8",
    immutable: true,
  },
};

const ROOT = path.join(process.cwd(), "vendor", "cp12-generator");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file?: string[] }> },
) {
  try {
    await requireEngineerOrThrow();
  } catch {
    /*
      A page, not a fetch — but middleware has already redirected an
      unauthenticated browser to the sign-in page, so anything reaching here
      without a session is not a browser following a link. It gets a status,
      not a login form.
    */
    return new NextResponse("Not found.", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { file } = await params;
  const key = (file ?? []).join("/");
  const entry = SERVABLE[key];
  if (!entry) {
    return new NextResponse("Not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let body: Buffer;
  try {
    body = await readFile(path.join(ROOT, entry.file));
  } catch {
    // The deployment is missing a vendored file. Say so plainly rather than
    // rendering half a generator.
    return new NextResponse("The certificate generator is not available.", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": entry.type,
      /*
        `private` on both, so no shared cache — a proxy, a CDN, the browser's
        own shared store — ever holds a response from an authenticated staff
        URL. The libraries are unchanging and worth keeping for the hour an
        engineer is working, which matters on a phone in a van; the page
        itself is never stored, because it is the surface a job's details are
        typed into and the next person at this browser must not find it
        restored from cache.
      */
      "Cache-Control": entry.immutable
        ? "private, max-age=3600, must-revalidate"
        : "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
