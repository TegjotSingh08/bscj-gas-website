import { NextResponse } from "next/server";

import { PostcodesIoProvider } from "@/lib/address/postcodes-io";
import { checkServiceArea } from "@/lib/address/service-area";
import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { requireAgentOrThrow } from "@/lib/auth/session";

/**
 * Postcode lookup for the portfolio.
 *
 * The same provider the public booking flow uses, behind an agency session.
 * Nothing about the address engine is reimplemented: this route validates the
 * postcode and hands back the canonical form and the town so the agent types
 * only what the system cannot derive.
 *
 * **Coverage is reported, not enforced.** The twelve-mile radius decides what
 * the public site will take an online booking for; it is not a rule about what
 * BSCJ will agree to do for a managed agency, whose portfolio routinely spans
 * a wider area. Refusing an out-of-area property here would refuse real work
 * the business already does — so the flag is advisory and the agent may
 * continue.
 *
 * No premise lookup. No free service can prove a house exists at a postcode,
 * and this route never implies one can — the agent still enters the house
 * number or name themselves, exactly as a customer does.
 */
export const dynamic = "force-dynamic";

const provider = new PostcodesIoProvider();

export async function POST(request: Request) {
  try {
    // A session, not a form field. This endpoint tells a caller whether a
    // postcode is real, so it is behind the same door as the portfolio.
    await requireAgentOrThrow();
  } catch {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  pruneRateLimits();
  const limited = await rateLimit(
    `portal-postcode:${clientKey(request)}`,
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

  const postcode =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { postcode?: unknown }).postcode === "string"
      ? (payload as { postcode: string }).postcode
      : "";

  if (!postcode) {
    return NextResponse.json({ status: "malformed" }, { status: 400 });
  }

  const result = await provider.lookup(postcode);

  if (result.status !== "valid") {
    return NextResponse.json({ status: result.status });
  }

  const area = checkServiceArea(result.postcode);

  return NextResponse.json({
    status: "valid",
    postcode: result.postcode.postcode,
    town: result.postcode.areaName,
    /* Advisory. The agent is told, and decides. */
    inStandardArea: area.covered === true,
  });
}
