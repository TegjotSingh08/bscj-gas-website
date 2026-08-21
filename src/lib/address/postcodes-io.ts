import "server-only";

import { looksLikePostcode, normalisePostcode } from "./format";
import type { PostcodeLookupResult, PostcodeProvider } from "./types";
import { getKvClient, KvUnavailableError } from "@/lib/kv/store";

/**
 * Postcode validation via Postcodes.io.
 *
 * Free, open, no credential and no rate limit to negotiate — which is why it
 * is the hard validation layer rather than the soft one. It answers a narrow
 * question well: is this a live UK postcode, and where is it.
 *
 * Results are cached because postcode data changes on a quarterly ONS cycle,
 * so a day is comfortably fresh and keeps traffic off a free public service.
 */

const ENDPOINT = "https://api.postcodes.io/postcodes";
const TIMEOUT_MS = 5000;
const CACHE_PREFIX = "postcode:";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function cacheKey(postcode: string): string {
  return `${CACHE_PREFIX}${postcode.replace(/\s+/g, "")}`;
}

type PostcodesIoResponse = {
  status?: number;
  result?: {
    postcode?: string;
    outcode?: string;
    latitude?: number | null;
    longitude?: number | null;
    admin_district?: string | null;
    region?: string | null;
  } | null;
};

export class PostcodesIoProvider implements PostcodeProvider {
  async lookup(rawPostcode: string): Promise<PostcodeLookupResult> {
    const postcode = normalisePostcode(rawPostcode);

    // Save a network call on input that cannot be a postcode.
    if (!looksLikePostcode(postcode)) return { status: "malformed" };

    const cached = await readCache(postcode);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(
        `${ENDPOINT}/${encodeURIComponent(postcode)}`,
        { signal: controller.signal, cache: "no-store" },
      );

      if (response.status === 404) {
        const result: PostcodeLookupResult = { status: "not_found" };
        await writeCache(postcode, result);
        return result;
      }

      if (!response.ok) return { status: "provider_unavailable" };

      const data = (await response.json()) as PostcodesIoResponse;
      const found = data.result;
      if (!found?.postcode || !found.outcode) {
        return { status: "provider_unavailable" };
      }

      const result: PostcodeLookupResult = {
        status: "valid",
        postcode: {
          postcode: found.postcode,
          outcode: found.outcode,
          areaName: found.admin_district || found.region || "",
          latitude: typeof found.latitude === "number" ? found.latitude : null,
          longitude: typeof found.longitude === "number" ? found.longitude : null,
        },
      };
      await writeCache(postcode, result);
      return result;
    } catch {
      // Timeout or network failure. Never reported as an invalid postcode.
      return { status: "provider_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCache(postcode: string): Promise<PostcodeLookupResult | null> {
  const client = getKvClient();
  if (!client) return null;
  try {
    const raw = await client.get(cacheKey(postcode));
    return raw ? (JSON.parse(raw) as PostcodeLookupResult) : null;
  } catch (error) {
    if (error instanceof KvUnavailableError) return null;
    return null;
  }
}

async function writeCache(
  postcode: string,
  result: PostcodeLookupResult,
): Promise<void> {
  const client = getKvClient();
  if (!client) return;
  try {
    await client.set(cacheKey(postcode), JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch {
    // Caching is an optimisation; failing to cache is not an error.
  }
}
