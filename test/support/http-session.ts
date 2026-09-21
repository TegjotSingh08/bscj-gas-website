/**
 * A real signed-in session, over HTTP, against the running application.
 *
 * **Why this exists.** A guard asserted by calling `assertCan("agent_owner",
 * …)` is a test of a lookup table. It says nothing about whether the page an
 * agency user actually requests is protected, whether the redirect goes
 * somewhere sensible, or whether a mutation they are not allowed to make
 * leaves the database alone. Those are properties of the running application,
 * and the only way to establish them is to be that user and make the request.
 *
 * Everything here goes through the shipping login form's own endpoint with a
 * real password. Nothing is bypassed, no session is forged, and no route
 * exists here that does not exist in production.
 */

import { BASE_URL } from "./browser-server";

export type HttpSession = {
  /** The Cookie header this session sends. */
  cookie(): string;
  /** What the application says this session is, read back from the server. */
  whoami(): Promise<{ role: string | null; email: string | null }>;
};

/** A cookie jar, because a session is cookies and nothing else. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    header: () =>
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    absorb(response: Response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/**
 * Signs in the way the form does: CSRF token, then the credentials callback.
 *
 * The fixture accounts carry hashes produced by the application's own
 * `hashPassword`, so this is the same check a real sign-in performs. It is
 * also the isolation proof: these accounts exist **only** in the throwaway
 * database, so a server that had reached any other one could not sign in.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<HttpSession> {
  const cookies = jar();

  const csrfResponse = await fetch(`${BASE_URL}/api/auth/csrf`);
  cookies.absorb(csrfResponse);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const response = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies.header(),
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${BASE_URL}/`,
      json: "true",
    }),
    redirect: "manual",
  });
  cookies.absorb(response);

  return {
    cookie: () => cookies.header(),
    async whoami() {
      const session = await fetch(`${BASE_URL}/api/auth/session`, {
        headers: { cookie: cookies.header() },
      });
      const body = (await session.json()) as {
        user?: { role?: string; email?: string };
      };
      return { role: body?.user?.role ?? null, email: body?.user?.email ?? null };
    },
  };
}

export type Hop = { status: number; location: string | null };

/**
 * Every hop a request takes, not just the first.
 *
 * **One redirect is not evidence.** A guard that sends an agency user to the
 * sign-in page looks correct at the first hop and can still be broken: if the
 * sign-in page sends them back, the two bounce off each other until the
 * browser gives up. That is exactly what was happening, and following only
 * one hop is what hid it. So the whole chain is followed and the final
 * destination is asserted.
 */
export async function follow(
  session: HttpSession | null,
  path: string,
  limit = 10,
): Promise<{ hops: Hop[]; finalStatus: number | null; finalPath: string }> {
  const hops: Hop[] = [];
  let url = new URL(path, BASE_URL);

  for (let step = 0; step < limit; step += 1) {
    const response = await fetch(url, {
      headers: session ? { cookie: session.cookie() } : {},
      redirect: "manual",
    });

    const location = response.headers.get("location");
    hops.push({ status: response.status, location });

    if (response.status < 300 || response.status >= 400 || !location) {
      // Drain, so the dev server is not left holding an open response.
      await response.arrayBuffer().catch(() => undefined);
      return {
        hops,
        finalStatus: response.status,
        finalPath: url.pathname + url.search,
      };
    }
    url = new URL(location, BASE_URL);
  }

  return { hops, finalStatus: null, finalPath: url.pathname + url.search };
}

/** A GET with this session, without following anything. */
export async function get(
  session: HttpSession | null,
  path: string,
): Promise<{ status: number; location: string | null; body: string }> {
  const response = await fetch(new URL(path, BASE_URL), {
    headers: session ? { cookie: session.cookie() } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}
