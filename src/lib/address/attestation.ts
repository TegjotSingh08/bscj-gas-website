import "server-only";

import { createHash } from "node:crypto";

import { getKvClient, type KvClient } from "@/lib/kv/store";
import { comparable, normalisePostcode } from "./format";
import type { AddressVerificationStatus } from "./types";

/**
 * Server-side record of what the verification step actually concluded.
 *
 * The browser is told the outcome so it can render the right panel, but it is
 * never believed at booking time: a POST claiming
 * `addressVerificationStatus: "verified"` proves nothing. Instead the booking
 * route recomputes this key from the submitted address and reads back what the
 * server itself decided.
 *
 * Keyed by the address only — no name, no email, no booking identity — so
 * nothing here is personal data beyond the property itself, and it expires.
 */

const PREFIX = "addrattest:";

/**
 * Comfortably longer than a 30 minute hold plus form filling, short enough
 * that a stale conclusion cannot outlive the booking attempt it belongs to.
 */
const TTL_SECONDS = 2 * 60 * 60;

export function attestationKey(input: {
  houseOrName: string;
  street: string;
  postcode: string;
}): string {
  const canonical = [
    normalisePostcode(input.postcode),
    comparable(input.houseOrName),
    comparable(input.street),
  ].join("|");
  return `${PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export async function recordVerification(
  input: { houseOrName: string; street: string; postcode: string },
  status: AddressVerificationStatus,
  client: KvClient | null = getKvClient(),
): Promise<void> {
  if (!client) return;
  try {
    await client.set(attestationKey(input), status, TTL_SECONDS);
  } catch {
    // Without a record the booking route simply treats the address as
    // unverified and asks the customer to confirm. That is the safe direction.
  }
}

/**
 * What the server concluded about this address, or null if it never checked.
 *
 * Null is treated as "unverified" by the caller, so a missing record can only
 * ever add friction, never remove it.
 */
export async function readVerification(
  input: { houseOrName: string; street: string; postcode: string },
  client: KvClient | null = getKvClient(),
): Promise<AddressVerificationStatus | null> {
  if (!client) return null;
  try {
    const stored = await client.get(attestationKey(input));
    if (stored === "verified" || stored === "partial_match" || stored === "unverified") {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}
