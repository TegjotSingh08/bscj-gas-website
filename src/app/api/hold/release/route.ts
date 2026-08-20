import { NextResponse } from "next/server";
import { z } from "zod";

import { releaseHold } from "@/lib/booking/holds";

export const dynamic = "force-dynamic";

const schema = z.object({
  slotStart: z.string().datetime(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Best-effort release when the customer leaves the page.
 *
 * A separate POST route because navigator.sendBeacon cannot issue DELETE, and
 * a beacon is the only request that reliably survives a tab closing. Nothing
 * depends on this arriving: the 30 minute TTL is the real cleanup, and the
 * release is refused unless the caller owns the hold.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ released: false }, { status: 400 });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ released: false }, { status: 400 });
  }

  const released = await releaseHold(parsed.data.slotStart, parsed.data.token);
  return NextResponse.json({ released });
}
