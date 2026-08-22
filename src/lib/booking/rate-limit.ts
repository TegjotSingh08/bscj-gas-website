import { getKvClient, KvUnavailableError, type KvClient } from "@/lib/kv/store";

/**
 * Rate limiting.
 *
 * Counters live in the shared store so limits hold across Vercel instances —
 * a per-process counter is close to meaningless when each request may land on
 * a different lambda.
 *
 * When the store is unreachable this falls back to a per-instance counter.
 * That is weaker than intended, but it fails towards still limiting rather
 * than not limiting at all, and it never blocks legitimate booking traffic
 * during an outage.
 */

export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

type Bucket = { count: number; resetAt: number };
const localBuckets = new Map<string, Bucket>();

function localRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const bucket = localBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    localBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

/** Keeps the fallback map from growing without bound on a warm instance. */
export function pruneRateLimits(now = Date.now()): void {
  for (const [key, bucket] of localBuckets) {
    if (bucket.resetAt <= now) localBuckets.delete(key);
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  client: KvClient | null = getKvClient(),
): Promise<RateLimitResult> {
  if (!client) return localRateLimit(key, limit, windowSeconds * 1000);

  try {
    const count = await client.incrementWithTtl(
      `rate:${key}`,
      windowSeconds,
    );
    if (count > limit) {
      return { ok: false, retryAfterSeconds: windowSeconds };
    }
    return { ok: true, retryAfterSeconds: 0 };
  } catch (error) {
    if (error instanceof KvUnavailableError) {
      return localRateLimit(key, limit, windowSeconds * 1000);
    }
    throw error;
  }
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/** Limits in one place, so they can be reasoned about together. */
export const rateLimits = {
  /** Browsing availability is cheap and legitimate users refresh often. */
  availability: { limit: 60, windowSeconds: 60 },
  /** Enough to change your mind repeatedly, not enough to sweep the diary. */
  hold: { limit: 20, windowSeconds: 600 },
  /** Confirming is rare; a person books once or twice. */
  booking: { limit: 8, windowSeconds: 600 },
  /** Postcode checks are cheap and a customer may correct a typo a few times. */
  postcode: { limit: 30, windowSeconds: 600 },
} as const;
