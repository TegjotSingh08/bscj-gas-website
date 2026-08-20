/**
 * Stand-in for `next/server` when route handlers are unit tested.
 *
 * `next/server` only resolves inside the Next runtime, and NextResponse.json
 * is a thin wrapper over the standard Response. Route handlers are plain
 * functions taking a Request and returning a Response, so this is enough to
 * exercise the real handler logic outside a server.
 */
export const NextResponse = {
  json(body, init = {}) {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  },
};
