import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  getKvClient,
  KvUnavailableError,
  type KvClient,
} from "@/lib/kv/store";

/**
 * The daily booking cap, and the thing that stops two customers slipping past
 * it at once.
 *
 * The cap itself is decided from Google Calendar, which is the only source of
 * truth for what has actually been booked. But counting and then writing is
 * two steps, and two requests confirming for the same day at the same moment
 * could both count nine and both write a tenth. This serialises them: a
 * booking holds a short lock on its own local date while it counts and writes,
 * so the second request counts *after* the first has landed.
 *
 * The lock is a guard, never the authority. If the store is unreachable the
 * booking still proceeds on the Google count alone — which is exactly the
 * protection that existed before this module, and the same posture the
 * 30-minute slot holds take. Failing bookings closed because Redis is down
 * would be a worse outcome than the rare chance of an eleventh appointment.
 */

/**
 * Long enough to cover a free/busy read, an events read and an event write;
 * short enough that a request dying mid-booking cannot wedge a whole day.
 */
export const DAILY_LOCK_TTL_SECONDS = 15;

/** Bounded retry, so ordinary contention is invisible to the customer. */
const LOCK_ATTEMPTS = 4;
const LOCK_RETRY_MS = 150;

const LOCK_PREFIX = "booking-day:";

function lockKey(isoDate: string): string {
  return `${LOCK_PREFIX}${isoDate}`;
}

export type DailyLock =
  | { status: "acquired"; token: string }
  /** Another booking for this date is in flight. The caller should back off. */
  | { status: "busy" }
  /** No store. The caller proceeds unguarded, on the Google count alone. */
  | { status: "unavailable" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Constant-time comparison, so a token cannot be probed byte by byte. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Takes the lock for one local date, retrying briefly if another booking holds
 * it. Contention is expected to be rare and short — the lock is held across
 * two Google reads and one write — so a few closely spaced attempts turn a
 * collision into a slight pause rather than an error.
 */
export async function acquireDailyBookingLock(
  isoDate: string,
  client: KvClient | null = getKvClient(),
  attempts = LOCK_ATTEMPTS,
  waitMs = LOCK_RETRY_MS,
): Promise<DailyLock> {
  if (!client) return { status: "unavailable" };

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = randomBytes(32).toString("hex");
      const won = await client.setIfAbsent(
        lockKey(isoDate),
        token,
        DAILY_LOCK_TTL_SECONDS,
      );
      if (won) return { status: "acquired", token };

      if (attempt < attempts - 1) await sleep(waitMs);
    }
    return { status: "busy" };
  } catch (error) {
    if (error instanceof KvUnavailableError) return { status: "unavailable" };
    throw error;
  }
}

/** Releases the lock, but only if this caller still owns it. */
export async function releaseDailyBookingLock(
  isoDate: string,
  token: string,
  client: KvClient | null = getKvClient(),
): Promise<boolean> {
  if (!client) return false;
  try {
    return await client.deleteIfEqual(lockKey(isoDate), token);
  } catch (error) {
    if (error instanceof KvUnavailableError) return false;
    throw error;
  }
}

/** Exported for tests that need to reason about ownership directly. */
export function dailyLockTokensMatch(a: string, b: string): boolean {
  return tokensMatch(a, b);
}
