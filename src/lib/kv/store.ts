/**
 * Distributed key/value store used for temporary appointment holds and for
 * rate limiting.
 *
 * Talks to Upstash Redis over its REST API with plain fetch, so nothing is
 * added to the dependency list and there is no TCP connection to pool — which
 * is what makes it work correctly across many short-lived Vercel instances.
 *
 * Deliberately a narrow interface: the booking code depends on these few
 * operations, not on Redis itself, so the tests can run against a fake with
 * the same semantics and a different provider could be swapped in later.
 */

export interface KvClient {
  /** SET key value NX EX ttl. True when this caller won the key. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Compare-and-delete. True when the value matched and the key was removed. */
  deleteIfEqual(key: string, value: string): Promise<boolean>;
  /** Remaining life in seconds. Negative when missing or without a TTL. */
  ttl(key: string): Promise<number>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** INCR, applying the TTL on first increment. Returns the new count. */
  incrementWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

/** Raised when the store cannot be reached. Never means "the slot is free". */
export class KvUnavailableError extends Error {
  constructor(message = "The reservation store is unavailable.") {
    super(message);
    this.name = "KvUnavailableError";
  }
}

/** Compare-and-delete: only the owner of a hold may release it. */
const DELETE_IF_EQUAL = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** Counter that expires as a whole window, rather than per increment. */
const INCREMENT_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count`;

type UpstashResult = { result?: unknown; error?: string };

class UpstashClient implements KvClient {
  // Plain fields rather than constructor parameter properties: Node's
  // type-stripping cannot parse the latter, and this module is unit tested.
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async command(parts: (string | number)[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parts.map(String)),
        cache: "no-store",
      });
    } catch {
      // Network failure. The body is never echoed: it can carry the token.
      throw new KvUnavailableError();
    }

    if (!response.ok) throw new KvUnavailableError();

    let payload: UpstashResult;
    try {
      payload = (await response.json()) as UpstashResult;
    } catch {
      throw new KvUnavailableError();
    }

    if (payload.error) throw new KvUnavailableError();
    return payload.result;
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    const result = await this.command(["SET", key, value, "NX", "EX", ttlSeconds]);
    return result === "OK";
  }

  async get(key: string) {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  async deleteIfEqual(key: string, value: string) {
    const result = await this.command([
      "EVAL",
      DELETE_IF_EQUAL,
      1,
      key,
      value,
    ]);
    return Number(result) === 1;
  }

  async ttl(key: string) {
    return Number(await this.command(["TTL", key]));
  }

  async mget(keys: string[]) {
    if (keys.length === 0) return [];
    const result = await this.command(["MGET", ...keys]);
    if (!Array.isArray(result)) throw new KvUnavailableError();
    return result.map((value) => (typeof value === "string" ? value : null));
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.command(["SET", key, value, "EX", ttlSeconds]);
  }

  async incrementWithTtl(key: string, ttlSeconds: number) {
    const result = await this.command([
      "EVAL",
      INCREMENT_WITH_TTL,
      1,
      key,
      ttlSeconds,
    ]);
    return Number(result);
  }
}

let cachedClient: KvClient | null = null;

/** The configured client, or null when the store is not set up at all. */
export function getKvClient(): KvClient | null {
  if (cachedClient) return cachedClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  cachedClient = new UpstashClient(url, token);
  return cachedClient;
}

export function isKvConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

/** Test seam. */
export function setKvClientForTesting(client: KvClient | null): void {
  cachedClient = client;
}
