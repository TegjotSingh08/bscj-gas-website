import { NextResponse } from "next/server";
import { z } from "zod";

import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { PostcodesIoProvider } from "@/lib/address/postcodes-io";
import { checkServiceArea, serviceAreaSummary } from "@/lib/address/service-area";

export const dynamic = "force-dynamic";

const schema = z.object({
  postcode: z.string().trim().min(2).max(12),
});

const provider = new PostcodesIoProvider();

/**
 * Validates a postcode and reports whether the property is inside the area we
 * take instant online bookings for.
 *
 * "Valid postcode" and "inside our area" are kept strictly separate: a
 * Birmingham postcode is perfectly real, it is simply not somewhere the
 * engineer covers without a conversation first.
 */
export async function POST(request: Request) {
  pruneRateLimits();
  const limited = await rateLimit(
    `postcode:${clientKey(request)}`,
    rateLimits.postcode.limit,
    rateLimits.postcode.windowSeconds,
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSeconds) },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ status: "malformed" }, { status: 400 });
  }

  const result = await provider.lookup(parsed.data.postcode);

  if (result.status === "malformed") {
    return NextResponse.json({ status: "malformed" });
  }

  if (result.status === "not_found") {
    return NextResponse.json({ status: "not_found" });
  }

  if (result.status === "provider_unavailable") {
    // Deliberately not reported as an invalid postcode: the customer's input
    // may be perfectly correct and we simply could not ask.
    return NextResponse.json({ status: "provider_unavailable" }, { status: 503 });
  }

  const area = checkServiceArea(result.postcode);

  return NextResponse.json({
    status: "valid",
    postcode: result.postcode,
    covered: area.covered,
    areaSummary: area.covered ? null : serviceAreaSummary(),
  });
}
