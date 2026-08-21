import { NextResponse } from "next/server";
import { z } from "zod";

import {
  clientKey,
  pruneRateLimits,
  rateLimit,
  rateLimits,
} from "@/lib/booking/rate-limit";
import { recordVerification } from "@/lib/address/attestation";
import { buildPropertyAddress, normaliseLine } from "@/lib/address/format";
import { NominatimProvider } from "@/lib/address/nominatim";
import { PostcodesIoProvider } from "@/lib/address/postcodes-io";
import { checkServiceArea } from "@/lib/address/service-area";

export const dynamic = "force-dynamic";

/**
 * Deliberately narrow. This is not an open geocoding proxy: it accepts a
 * house/name, a street and a postcode, and only after that postcode has been
 * confirmed live and inside the service area. Arbitrary queries cannot be
 * passed through to the mapping service.
 */
const schema = z.object({
  houseOrName: z.string().trim().min(1).max(60),
  street: z.string().trim().min(2).max(120),
  postcode: z.string().trim().min(5).max(12),
});

const postcodes = new PostcodesIoProvider();
const verifier = new NominatimProvider();

export async function POST(request: Request) {
  pruneRateLimits();
  const limited = await rateLimit(
    `addrverify:${clientKey(request)}`,
    rateLimits.addressVerify.limit,
    rateLimits.addressVerify.windowSeconds,
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
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { houseOrName, street } = parsed.data;

  // The postcode is re-established here rather than trusted from the browser,
  // so the mapping service is only ever asked about a real, covered postcode.
  const lookup = await postcodes.lookup(parsed.data.postcode);
  if (lookup.status !== "valid") {
    return NextResponse.json({ error: "postcode_invalid" }, { status: 400 });
  }
  if (!checkServiceArea(lookup.postcode.outcode).covered) {
    return NextResponse.json({ error: "outside_area" }, { status: 400 });
  }

  const verification = await verifier.verify({
    houseOrName,
    street,
    postcode: lookup.postcode.postcode,
  });

  // "unavailable" means we could not ask — the throttle was held, the service
  // was down, or there is no store to coordinate with. The customer confirms
  // manually instead, and the booking is never blocked.
  const status =
    verification.status === "unavailable" ? "unverified" : verification.status;

  await recordVerification(
    { houseOrName, street, postcode: lookup.postcode.postcode },
    status,
  );

  const address = buildPropertyAddress({
    houseOrName,
    street,
    postcode: lookup.postcode,
    verificationStatus: status,
    confirmedByCustomer: false,
  });

  return NextResponse.json({
    status,
    /** True when we genuinely could not reach the service, for honest wording. */
    checkUnavailable: verification.status === "unavailable",
    address: {
      houseOrName: address.houseOrName,
      street: address.street,
      town: address.town,
      postcode: address.postcode,
      formattedAddress: address.formattedAddress,
      lines: [
        normaliseLine(`${address.houseOrName} ${address.street}`),
        address.town,
        address.postcode,
      ].filter(Boolean),
    },
  });
}
