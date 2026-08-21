import "server-only";

import { createHash } from "node:crypto";

import { business } from "@/lib/business";
import { getKvClient, KvUnavailableError, type KvClient } from "@/lib/kv/store";
import { comparable, normaliseLine, normalisePostcode } from "./format";
import { bestMatch } from "./match";
import type {
  AddressVerificationProvider,
  AddressVerificationResult,
} from "./types";

/**
 * Secondary address confidence check against the public OpenStreetMap
 * Nominatim service.
 *
 * This is NOT an authoritative address source. OpenStreetMap does not contain
 * every house number, new build, flat, private road or recently renamed
 * street, so "no match" means "we could not confirm it", never "wrong".
 *
 * The public service is run on donated infrastructure and its usage policy is
 * strict. Everything below exists to honour it:
 *
 *   - at most one request per second, coordinated across every server
 *     instance through the shared Redis store, not a per-process timer
 *   - one request only, after the customer has finished typing the address —
 *     never autocomplete, never per keystroke
 *   - identical requests are answered from cache
 *   - an identifying User-Agent naming the application and a contact address
 *   - if the throttle cannot be coordinated, no request is made at all
 *
 * See docs/ADDRESS_VALIDATION.md.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 6000;

/** Identifies this application, as the usage policy requires. */
const USER_AGENT = `BSCJGasHeating-Booking/1.0 (+${business.url}; ${business.emailGeneral})`;

/**
 * Address data changes slowly — a street does not move — so a long cache is
 * both accurate and the single biggest reduction in traffic to a free service.
 */
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const CACHE_PREFIX = "addrverify:";

/**
 * Bumped whenever the matching rules in match.ts change.
 *
 * Cached verdicts live for 30 days, so without this a logic change would be
 * invisible for a month on every address already checked — exactly what
 * happened when district-level postcode matching was introduced.
 */
const MATCH_LOGIC_VERSION = "v2";

/**
 * The global one-request-per-second gate. A one second expiry means the key
 * cannot be taken twice within a second by any instance.
 */
const THROTTLE_KEY = "nominatim:gate";
const THROTTLE_TTL_SECONDS = 1;

/** How long to wait for the gate before giving up and asking the customer. */
const THROTTLE_ATTEMPTS = 3;
const THROTTLE_WAIT_MS = 400;

type NominatimResult = {
  address?: {
    house_number?: string;
    road?: string;
    postcode?: string;
  };
};

/** Same address, however it was typed, produces the same key. */
export function verificationCacheKey(input: {
  houseOrName: string;
  street: string;
  postcode: string;
}): string {
  const canonical = [
    MATCH_LOGIC_VERSION,
    normalisePostcode(input.postcode),
    comparable(input.houseOrName),
    comparable(input.street),
  ].join("|");
  return `${CACHE_PREFIX}${MATCH_LOGIC_VERSION}:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the global gate, or reports that it could not.
 *
 * Without a store there is no way to coordinate the rate across instances, so
 * the honest answer is not to call the service at all.
 */
async function takeThrottleSlot(client: KvClient | null): Promise<boolean> {
  if (!client) return false;

  for (let attempt = 0; attempt < THROTTLE_ATTEMPTS; attempt += 1) {
    try {
      const taken = await client.setIfAbsent(
        THROTTLE_KEY,
        String(Date.now()),
        THROTTLE_TTL_SECONDS,
      );
      if (taken) return true;
    } catch (error) {
      if (error instanceof KvUnavailableError) return false;
      return false;
    }
    if (attempt < THROTTLE_ATTEMPTS - 1) await sleep(THROTTLE_WAIT_MS);
  }
  return false;
}

export class NominatimProvider implements AddressVerificationProvider {
  async verify(input: {
    houseOrName: string;
    street: string;
    postcode: string;
  }): Promise<AddressVerificationResult> {
    const client = getKvClient();
    const key = verificationCacheKey(input);

    const cached = await readCache(client, key);
    if (cached) return cached;

    // No cached answer, so a request is needed — and it only happens if the
    // global rate can be guaranteed.
    const allowed = await takeThrottleSlot(client);
    if (!allowed) return { status: "unavailable" };

    const params = new URLSearchParams({
      // Structured query only. The policy and the API both discourage mixing
      // free-form q with structured fields.
      street: normaliseLine(`${input.houseOrName} ${input.street}`),
      postalcode: normalisePostcode(input.postcode),
      countrycodes: "gb",
      format: "jsonv2",
      addressdetails: "1",
      limit: "3",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-GB",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      // Being throttled by the service is a signal to back off, not to guess.
      if (response.status === 429 || response.status === 403) {
        return { status: "unavailable" };
      }
      if (!response.ok) return { status: "unavailable" };

      const data = (await response.json()) as NominatimResult[];
      const candidates = (Array.isArray(data) ? data : []).map((entry) => ({
        street: entry.address?.road ?? null,
        houseNumber: entry.address?.house_number ?? null,
        postcode: entry.address?.postcode ?? null,
      }));

      const match = bestMatch(candidates, {
        houseOrName: input.houseOrName,
        street: input.street,
        postcode: input.postcode,
      });

      const result: AddressVerificationResult =
        match.status === "unverified"
          ? { status: "unverified" }
          : {
              status: match.status,
              matchedStreet: match.matchedStreet,
              matchedHouseNumber: match.matchedHouseNumber,
            };

      await writeCache(client, key, result);
      return result;
    } catch {
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCache(
  client: KvClient | null,
  key: string,
): Promise<AddressVerificationResult | null> {
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw ? (JSON.parse(raw) as AddressVerificationResult) : null;
  } catch {
    return null;
  }
}

async function writeCache(
  client: KvClient | null,
  key: string,
  result: AddressVerificationResult,
): Promise<void> {
  if (!client) return;
  // "unavailable" is about us, not the address, so it is never cached.
  if (result.status === "unavailable") return;
  try {
    await client.set(key, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch {
    // Caching is an optimisation.
  }
}
