import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  getKvClient,
  KvUnavailableError,
  type KvClient,
} from "@/lib/kv/store";

/**
 * Temporary appointment reservations.
 *
 * When a customer picks a time we reserve it for them for 30 minutes while
 * they fill in the rest of the form, so nobody else is offered the same slot
 * in the meantime. The hold is a convenience layer, not the source of truth:
 * Google Calendar remains authoritative for confirmed appointments, and its
 * pre-write re-check is never skipped because a hold looks valid.
 *
 * No customer data is stored — a hold is a slot key mapped to an opaque id.
 */

/** Exactly 30 minutes. The single place this is defined. */
export const HOLD_DURATION_SECONDS = 1800;

/** Below this, the UI makes the countdown more prominent. */
export const HOLD_WARNING_SECONDS = 300;

const HOLD_PREFIX = "booking-hold:";
const COMPLETED_PREFIX = "booking-done:";

/** How long a completed-booking marker lives, for duplicate submissions. */
const COMPLETED_TTL_SECONDS = 3600;

export type HoldOutcome =
  | { status: "acquired"; token: string; slotStart: string; expiresAt: string }
  | { status: "taken" }
  | { status: "unavailable" };

export type HoldCheck =
  | { status: "valid"; secondsRemaining: number }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "unavailable" };

function holdKey(slotStartIso: string): string {
  return `${HOLD_PREFIX}${slotStartIso}`;
}

function completedKey(idempotencyKey: string): string {
  return `${COMPLETED_PREFIX}${idempotencyKey}`;
}

/** 32 bytes of CSPRNG output, hex encoded. Opaque to the browser. */
export function generateHoldToken(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time comparison, so a token cannot be probed byte by byte. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A token that could not have come from us is rejected without a store call. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

/**
 * Attempts to reserve a slot. Atomic: exactly one caller can win, because the
 * underlying write is SET NX EX.
 *
 * When switching times, the replacement is acquired first and the previous
 * reservation released only once that succeeds. A booking attempt therefore
 * owns exactly zero or one hold at any moment a customer could observe it,
 * and a failed switch leaves the original reservation intact.
 */
export async function acquireHold(
  slotStartIso: string,
  previous?: { slotStart: string; token: string },
  client: KvClient | null = getKvClient(),
): Promise<HoldOutcome> {
  if (!client) return { status: "unavailable" };

  try {
    const token = generateHoldToken();

    // Acquire the replacement BEFORE letting go of anything. Releasing first
    // would leave a customer with no reservation at all whenever the slot they
    // were switching to had just been taken.
    const won = await client.setIfAbsent(
      holdKey(slotStartIso),
      token,
      HOLD_DURATION_SECONDS,
    );

    if (!won) {
      // Re-selecting the slot this attempt already owns is not a conflict.
      if (previous && previous.slotStart === slotStartIso) {
        const existing = await client.get(holdKey(slotStartIso));
        if (existing && tokensMatch(existing, previous.token)) {
          const ttl = await client.ttl(holdKey(slotStartIso));
          return {
            status: "acquired",
            token: previous.token,
            slotStart: slotStartIso,
            expiresAt: new Date(
              Date.now() + Math.max(ttl, 0) * 1000,
            ).toISOString(),
          };
        }
      }
      // The old reservation is deliberately left untouched.
      return { status: "taken" };
    }

    // Only now is the previous reservation given up, so the attempt owns
    // exactly one hold at every point a customer could observe it.
    if (previous && previous.slotStart !== slotStartIso) {
      // Best effort: if this fails the old hold expires on its own TTL.
      await releaseHold(previous.slotStart, previous.token, client);
    }

    return {
      status: "acquired",
      token,
      slotStart: slotStartIso,
      expiresAt: new Date(
        Date.now() + HOLD_DURATION_SECONDS * 1000,
      ).toISOString(),
    };
  } catch (error) {
    if (error instanceof KvUnavailableError) return { status: "unavailable" };
    throw error;
  }
}

/** Releases a hold, but only if the caller owns it. */
export async function releaseHold(
  slotStartIso: string,
  token: string,
  client: KvClient | null = getKvClient(),
): Promise<boolean> {
  if (!client || !isWellFormedToken(token)) return false;
  try {
    return await client.deleteIfEqual(holdKey(slotStartIso), token);
  } catch (error) {
    if (error instanceof KvUnavailableError) return false;
    throw error;
  }
}

/**
 * Confirms a hold is real, unexpired, and belongs to this attempt and slot.
 *
 * A forged, wrong-slot or expired token all fail here. The browser holds only
 * an opaque string; slot, ownership and expiry are decided from the store.
 */
export async function checkHold(
  slotStartIso: string,
  token: unknown,
  client: KvClient | null = getKvClient(),
): Promise<HoldCheck> {
  if (!client) return { status: "unavailable" };
  if (!isWellFormedToken(token)) return { status: "mismatch" };

  try {
    const stored = await client.get(holdKey(slotStartIso));
    if (!stored) return { status: "expired" };
    if (!tokensMatch(stored, token)) return { status: "mismatch" };

    const ttl = await client.ttl(holdKey(slotStartIso));
    if (ttl <= 0) return { status: "expired" };

    return { status: "valid", secondsRemaining: ttl };
  } catch (error) {
    if (error instanceof KvUnavailableError) return { status: "unavailable" };
    throw error;
  }
}

/**
 * Slots currently held by someone else.
 *
 * The caller's own hold is excluded, so their reservation keeps showing as
 * selectable to them. Other people's hold ids are never returned — only the
 * fact that a slot is spoken for.
 */
export async function findHeldSlots(
  slotStartIsos: string[],
  own?: { slotStart: string; token: string },
  client: KvClient | null = getKvClient(),
): Promise<Set<string>> {
  const held = new Set<string>();
  if (!client || slotStartIsos.length === 0) return held;

  try {
    const values = await client.mget(slotStartIsos.map(holdKey));
    slotStartIsos.forEach((slot, index) => {
      const value = values[index];
      if (!value) return;
      const isOwn =
        own !== undefined &&
        own.slotStart === slot &&
        isWellFormedToken(own.token) &&
        tokensMatch(value, own.token);
      if (!isOwn) held.add(slot);
    });
    return held;
  } catch (error) {
    if (error instanceof KvUnavailableError) {
      // Holds are unknown. Availability falls back to Google alone, which is
      // the behaviour that existed before holds — first confirmed wins.
      return held;
    }
    throw error;
  }
}

/** Marks a booking attempt as completed, so a repeat submission is recognised. */
export async function markBookingCompleted(
  idempotencyKey: string,
  eventId: string,
  client: KvClient | null = getKvClient(),
): Promise<void> {
  if (!client) return;
  try {
    await client.set(
      completedKey(idempotencyKey),
      eventId,
      COMPLETED_TTL_SECONDS,
    );
  } catch (error) {
    if (error instanceof KvUnavailableError) return;
    throw error;
  }
}

/** The event id a previous submission of this attempt created, if any. */
export async function findCompletedBooking(
  idempotencyKey: string,
  client: KvClient | null = getKvClient(),
): Promise<string | null> {
  if (!client) return null;
  try {
    return await client.get(completedKey(idempotencyKey));
  } catch (error) {
    if (error instanceof KvUnavailableError) return null;
    throw error;
  }
}
