import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Letting a scheduler in, without opening a second front door.
 *
 * Everything else that mutates in this application is behind an administrator
 * session, and that is the right default — but a cron job cannot hold one. So
 * exactly one alternative exists, and it is deliberately narrow:
 *
 * - **It is off unless `CRON_SECRET` is set.** An unset secret does not mean
 *   "allow anyone"; it means this door does not exist. Failing closed is the
 *   only safe reading of a missing credential.
 * - **The secret is compared in constant time**, so it cannot be probed a byte
 *   at a time.
 * - **It grants one thing**: draining the outbox. It is not a session, it
 *   carries no identity, and nothing reads it as an administrator.
 *
 * `Authorization: Bearer <secret>` is the shape Vercel Cron sends, which is
 * why it is the shape accepted here.
 */

export type CronAuth = { ok: true } | { ok: false };

/** A secret worth having. Short values are refused rather than warned about. */
const MINIMUM_SECRET_LENGTH = 24;

export function isCronConfigured(): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && secret.length >= MINIMUM_SECRET_LENGTH);
}

export function checkCronSecret(request: Request): CronAuth {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < MINIMUM_SECRET_LENGTH) return { ok: false };

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return { ok: false };

  const offered = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (offered.length !== expected.length) return { ok: false };

  return timingSafeEqual(offered, expected) ? { ok: true } : { ok: false };
}
