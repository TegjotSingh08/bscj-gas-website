import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  getKvClient,
  KvUnavailableError,
  type KvClient,
} from "@/lib/kv/store";
import { blockMinutesFor, bookingConfigFor } from "./config";
import { DEFAULT_PRODUCT_ID, type ProductId } from "./products";

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
 *
 * A hold covers **every start time the booking conflicts with**, not just the
 * one the customer clicked. That matters now the two products have different
 * lengths: a 60-minute bundle reserved at 10:00 runs to 11:00 and its buffer to
 * 11:15, so 11:00 must stop being offered to anyone else. Keying on the start
 * alone would have let a second customer reserve 11:00, fill in the whole form
 * and only then be refused by the calendar re-check.
 *
 * All of an attempt's keys carry the same token, so the attempt has one
 * identity for its whole life and a key it already owns is never mistaken for
 * somebody else's.
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
  | {
      status: "acquired";
      token: string;
      slotStart: string;
      productId: ProductId;
      expiresAt: string;
    }
  | { status: "taken" }
  | { status: "unavailable" };

/** A reservation this attempt already owns, sent with every acquisition. */
export type PreviousHold = {
  slotStart: string;
  token: string;
  /** Needed to work out which keys the old reservation occupied. */
  productId?: ProductId;
};

export type HoldCheck =
  | { status: "valid"; secondsRemaining: number }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "unavailable" };

/**
 * Canonicalised, so two spellings of the same instant cannot produce two keys
 * for one appointment. A value that is not a date at all is keyed verbatim and
 * simply never matches anything.
 */
function holdKey(slotStartIso: string): string {
  const parsed = new Date(slotStartIso);
  const canonical = Number.isNaN(parsed.getTime())
    ? slotStartIso
    : parsed.toISOString();
  return `${HOLD_PREFIX}${canonical}`;
}

/**
 * Every offered start time a booking of this product conflicts with, its own
 * included.
 *
 * The span is the appointment plus its buffer, walked in slot-interval steps.
 * A 45-minute CP12 spans 60 minutes and so reserves only its own start —
 * exactly the behaviour that existed before products. A 60-minute bundle spans
 * 75 and so reserves the next hour too.
 *
 * That one rule is enough to catch conflicts in both directions. Two
 * appointments clash only when the later one starts before the earlier one's
 * block ends, and in that case the later start is inside the earlier
 * booking's key set — so whichever attempt reserves second collides.
 */
export function conflictingSlotStarts(
  slotStartIso: string,
  productId: ProductId = DEFAULT_PRODUCT_ID,
): string[] {
  const start = new Date(slotStartIso);
  if (Number.isNaN(start.getTime())) return [];

  const config = bookingConfigFor(productId);
  const span = blockMinutesFor(config);

  const starts: string[] = [];
  for (let offset = 0; offset < span; offset += config.slotIntervalMinutes) {
    starts.push(new Date(start.getTime() + offset * 60000).toISOString());
  }
  return starts;
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

/** Best effort: a key that cannot be given back simply expires on its TTL. */
async function releaseKey(
  slotStartIso: string,
  token: string,
  client: KvClient,
): Promise<boolean> {
  try {
    return await client.deleteIfEqual(holdKey(slotStartIso), token);
  } catch (error) {
    if (error instanceof KvUnavailableError) return false;
    throw error;
  }
}

/**
 * Attempts to reserve every slot a booking conflicts with. Atomic per key,
 * because the underlying write is SET NX EX, and all-or-nothing overall: a
 * partial acquisition is rolled back before returning.
 *
 * Two rules keep a customer from ever losing what they already hold:
 *
 * 1. The replacement is acquired BEFORE the previous reservation is released,
 *    so a slot lost to someone else costs nothing.
 * 2. A rollback undoes only the keys THIS call created. Keys the attempt
 *    already owned are left exactly as they were, so a failed switch leaves
 *    the original reservation intact and running on its own TTL.
 *
 * The attempt keeps one token for its whole life. That is what lets a key it
 * already owns be recognised rather than mistaken for a conflict when the
 * customer switches product on the same time, or moves to a time its previous
 * booking already overlapped.
 */
export async function acquireHold(
  slotStartIso: string,
  productId: ProductId = DEFAULT_PRODUCT_ID,
  previous?: PreviousHold,
  client: KvClient | null = getKvClient(),
): Promise<HoldOutcome> {
  if (!client) return { status: "unavailable" };

  const keys = conflictingSlotStarts(slotStartIso, productId);
  if (keys.length === 0) return { status: "unavailable" };

  // Keys created by this call, and only these, are undone on failure.
  const acquired: string[] = [];

  // Carrying the previous token forward is what makes an already-owned key
  // recognisable. It is adopted only once the store confirms that token really
  // does hold the reservation being presented, so a token that has expired —
  // or was never ours — starts a fresh identity instead.
  let token = generateHoldToken();

  // How long any key created here should live. A reservation expires as a
  // whole, decided by its own start, so a start added by lengthening the
  // service must inherit what is left rather than win a fresh thirty minutes —
  // otherwise it would go on blocking that hour after the reservation behind
  // it had already gone.
  let ttlSeconds = HOLD_DURATION_SECONDS;

  try {
    if (previous && isWellFormedToken(previous.token)) {
      const owner = await client.get(holdKey(previous.slotStart));
      if (owner && tokensMatch(owner, previous.token)) {
        token = previous.token;

        // Only when re-selecting the very time this attempt already holds.
        // Moving to a different time is a new reservation and earns its own
        // full thirty minutes, exactly as it always did.
        if (holdKey(previous.slotStart) === holdKey(slotStartIso)) {
          const remaining = await client.ttl(holdKey(slotStartIso));
          if (remaining > 0) ttlSeconds = remaining;
        }
      }
    }

    for (const key of keys) {
      const won = await client.setIfAbsent(holdKey(key), token, ttlSeconds);
      if (won) {
        acquired.push(key);
        continue;
      }

      // Already ours — re-selecting the same time, or a longer product
      // reaching over a start this attempt had already reserved.
      const stored = await client.get(holdKey(key));
      if (stored && tokensMatch(stored, token)) continue;

      // Somebody else has it. Undo this call's own writes and leave every
      // pre-existing reservation, including the customer's, untouched.
      for (const created of acquired) {
        await releaseKey(created, token, client);
      }
      return { status: "taken" };
    }

    // Only now is anything given up, and only the keys the new reservation
    // does not need. This covers both moving to a different time and swapping
    // to a shorter product on the same one.
    if (previous) {
      const keep = new Set(keys.map(holdKey));
      const stale = conflictingSlotStarts(
        previous.slotStart,
        previous.productId ?? DEFAULT_PRODUCT_ID,
      ).filter((key) => !keep.has(holdKey(key)));

      for (const key of stale) {
        await releaseKey(key, token, client);
      }
    }

    // Read back rather than assumed: re-selecting a slot this attempt already
    // held keeps its original expiry, it does not win a fresh 30 minutes.
    const ttl = await client.ttl(holdKey(slotStartIso));
    const remaining = ttl > 0 ? ttl : HOLD_DURATION_SECONDS;

    return {
      status: "acquired",
      token,
      slotStart: slotStartIso,
      productId,
      expiresAt: new Date(Date.now() + remaining * 1000).toISOString(),
    };
  } catch (error) {
    if (error instanceof KvUnavailableError) {
      // The store went away mid-acquisition. Try to undo what landed; if that
      // fails too, the TTL is the backstop it has always been.
      for (const created of acquired) {
        try {
          await client.deleteIfEqual(holdKey(created), token);
        } catch {
          // Nothing further to do — the reservation expires on its own.
        }
      }
      return { status: "unavailable" };
    }
    throw error;
  }
}

/**
 * Releases a reservation, but only if the caller owns it.
 *
 * Every key the booking occupied is given back, not just the start the
 * customer clicked, so a released bundle stops blocking the hour after it.
 * The return value reports the start itself, which is the reservation's
 * identity.
 */
export async function releaseHold(
  slotStartIso: string,
  token: string,
  productId: ProductId = DEFAULT_PRODUCT_ID,
  client: KvClient | null = getKvClient(),
): Promise<boolean> {
  if (!client || !isWellFormedToken(token)) return false;

  let releasedPrimary = false;
  for (const key of conflictingSlotStarts(slotStartIso, productId)) {
    const released = await releaseKey(key, token, client);
    if (holdKey(key) === holdKey(slotStartIso)) releasedPrimary = released;
  }
  return releasedPrimary;
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
      // Any key carrying this attempt's token is its own — including the
      // spillover a longer booking reserves beyond its start. Matching on the
      // token alone rather than on the slot is what keeps a customer holding a
      // 10:00 bundle able to see, and move to, 11:00.
      const isOwn =
        own !== undefined &&
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
