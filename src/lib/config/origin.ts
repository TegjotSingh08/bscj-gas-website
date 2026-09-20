import "server-only";

import { business } from "@/lib/business";

/**
 * Where this deployment actually is, for links somebody will click.
 *
 * **`business.url` is the canonical *marketing* origin and must not be used
 * for transactional links.** The two are different jobs that happened to share
 * one constant:
 *
 * - The canonical origin is what a crawler should index and what appears in a
 *   sitemap, a `metadataBase`, schema.org markup and an email footer. It is
 *   `https://www.bscj-solutions.com` wherever the code is running, because
 *   that is where the public site lives and a staging deployment must not
 *   advertise itself as a second copy of it.
 * - The **app origin** is where *this* deployment is served from. An
 *   invitation minted on staging has to send the person to staging, or they
 *   arrive at production, where their account does not exist and their link
 *   hashes to nothing. The link then looks forged to them and broken to us.
 *
 * Before this module the two were the same string, so every invitation, reset,
 * tenant scheduling link and portal deep link sent from anywhere pointed at
 * production. That is fine in production and wrong everywhere else — which is
 * precisely the configuration a pilot runs in.
 *
 * **Never from a request header.** `Host` and `X-Forwarded-Host` are attacker
 * controlled: a request carrying `Host: evil.example` would mint an invitation
 * pointing at `evil.example`, and the token in it is a working credential.
 * Every value here comes from the server's own environment, which an HTTP
 * client cannot set.
 */

export type Deployment = "development" | "preview" | "production";

export class AppOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppOriginError";
  }
}

/**
 * Which kind of deployment this is.
 *
 * `VERCEL_ENV` when the platform sets it, because it distinguishes a preview
 * from production and `NODE_ENV` does not — a preview build is
 * `NODE_ENV=production` too, and treating one as the other is how a preview
 * ends up sending production links.
 */
export function deployment(): Deployment {
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production") return "production";
  if (vercel === "preview" || vercel === "development") {
    return vercel === "preview" ? "preview" : "development";
  }
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Validates an origin.
 *
 * Deliberately strict, because the output is concatenated with a path and a
 * credential. A trailing path, a query string or embedded userinfo would all
 * produce a link that is not what anybody intended, and `//evil.example` is a
 * protocol-relative URL that resolves somewhere else entirely.
 *
 * Returns the normalised `scheme://host[:port]`, with no trailing slash.
 */
export function validateOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AppOriginError("The app origin is empty.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppOriginError(
      "The app origin is not a URL. Give a full origin, e.g. https://staging.example.com.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppOriginError("The app origin must be http or https.");
  }
  if (url.username || url.password) {
    throw new AppOriginError("The app origin must not contain credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new AppOriginError(
      "The app origin must be an origin only — no path, query or fragment.",
    );
  }

  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";

  /*
    Plain http is allowed only for a local development server. A token in a
    link sent over http is a token on the wire, and anything that is not
    localhost is on a wire.
  */
  if (url.protocol === "http:" && !local) {
    throw new AppOriginError("The app origin must be https unless it is localhost.");
  }

  return url.origin;
}

export type OriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/**
 * The origin for links this deployment sends, or a reason it cannot be known.
 *
 * Resolution order, and each step is deliberate:
 *
 * 1. **`BSCJ_APP_ORIGIN`**, whenever it is set. The explicit answer, and the
 *    one a staging or pilot deployment is expected to give. An invalid value
 *    is an error rather than something to fall back from — a fallback would
 *    quietly send pilot invitations to production.
 * 2. **Production** falls back to the canonical marketing origin, because in
 *    production they are genuinely the same place. So a correct production
 *    deployment needs no new variable.
 * 3. **Preview** uses `VERCEL_URL`, which the platform injects into the
 *    server's environment. It is not a request header and a client cannot
 *    influence it.
 * 4. **Development** uses localhost on the configured port.
 *
 * Returns a result rather than throwing, because every caller is inside a path
 * that must not fail loudly: the outbox records the gap against the row and
 * retries, which is how a missing setting becomes a queued message and a
 * named reason instead of a lost invitation.
 */
export function resolveAppOrigin(): OriginResult {
  const declared = process.env.BSCJ_APP_ORIGIN;
  if (declared && declared.trim()) {
    try {
      return { ok: true, origin: validateOrigin(declared) };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof AppOriginError
            ? error.message
            : "BSCJ_APP_ORIGIN is not usable.",
      };
    }
  }

  const where = deployment();

  if (where === "production") {
    try {
      return { ok: true, origin: validateOrigin(business.url) };
    } catch {
      return { ok: false, reason: "The canonical site URL is not a valid origin." };
    }
  }

  if (where === "preview") {
    const vercel = process.env.VERCEL_URL;
    if (!vercel) {
      return {
        ok: false,
        reason:
          "This is a preview deployment with neither BSCJ_APP_ORIGIN nor VERCEL_URL set, so a link cannot be addressed.",
      };
    }
    try {
      // VERCEL_URL is a bare host, deliberately without a scheme.
      return { ok: true, origin: validateOrigin(`https://${vercel}`) };
    } catch {
      return { ok: false, reason: "VERCEL_URL is not a usable host." };
    }
  }

  const port = process.env.PORT || "3000";
  return { ok: true, origin: `http://localhost:${port}` };
}

/**
 * An absolute link into **this** deployment.
 *
 * `path` must be rooted. Throws on a bad origin rather than returning a
 * half-built string, so a caller that has not checked cannot send one; the
 * outbox checks with `resolveAppOrigin` first and records the gap instead.
 */
export function linkTo(path: string): string {
  if (!path.startsWith("/")) {
    throw new AppOriginError(`A link path must start with "/": ${path}`);
  }
  const resolved = resolveAppOrigin();
  if (!resolved.ok) throw new AppOriginError(resolved.reason);
  return `${resolved.origin}${path}`;
}

/**
 * Whether links can be addressed at all, for the readiness screen.
 *
 * Named like `storageStatus()` and `isEmailConfigured()` so the deployment
 * checklist reads the same way for every service.
 */
export function appOriginStatus(): {
  deployment: Deployment;
  ready: boolean;
  /** Safe to display: an origin is not a secret. */
  origin: string | null;
  requirement: string | null;
} {
  const resolved = resolveAppOrigin();
  return {
    deployment: deployment(),
    ready: resolved.ok,
    origin: resolved.ok ? resolved.origin : null,
    requirement: resolved.ok ? null : resolved.reason,
  };
}
