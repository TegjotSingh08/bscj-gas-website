import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createSchedulingToken,
  hashToken,
  isWellFormedToken,
  tokenMatches,
  TOKEN_LIFETIME_DAYS,
} from "@/lib/scheduling/token";
import { submissionIdempotencyKey } from "./create-agent-job";
import { generateJobReference, isJobReference } from "./reference";
import { isInvoiceNumber } from "@/lib/invoices/number";
import { resolvePrice } from "@/lib/pricing/resolve";
import { buildPriceSnapshot } from "@/lib/pricing/snapshot";
import { calculatePrice } from "@/lib/booking/pricing";
import { products } from "@/lib/booking/products";

/**
 * Agent job creation.
 *
 * The pure parts — the token, the idempotency key, the pricing that gets
 * frozen onto a job — are tested directly here. The database-shaped guarantees
 * (isolation, atomicity, retries) are proved against the live development
 * database and recorded in `docs/V2_CURRENT_STATE.md`; mocking Drizzle deeply
 * enough to assert them would only prove the mock.
 */

describe("the scheduling token", () => {
  test("the plain token is high-entropy and never the stored value", () => {
    const minted = createSchedulingToken();
    assert.equal(minted.token.length, 64, "not 32 bytes of hex");
    assert.ok(isWellFormedToken(minted.token));
    assert.notEqual(minted.token, minted.tokenHash);
    assert.equal(
      minted.tokenHash.includes(minted.token),
      false,
      "the stored hash contains the token itself",
    );
  });

  test("the stored form names its algorithm, so a pepper can be added later", () => {
    // Self-describing, like the password hashes: introducing or rotating
    // SCHEDULING_TOKEN_SECRET must not invalidate links already sent.
    const minted = createSchedulingToken();
    assert.match(minted.tokenHash, /^(hmac|sha256)\$[0-9a-f]{64}$/);
  });

  test("a token verifies against its own hash and nothing else", () => {
    const a = createSchedulingToken();
    const b = createSchedulingToken();

    assert.equal(tokenMatches(a.token, a.tokenHash), true);
    assert.equal(tokenMatches(b.token, a.tokenHash), false);
    assert.equal(tokenMatches("", a.tokenHash), false);
  });

  test("two mints are never the same token", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seen.add(createSchedulingToken().token);
    }
    assert.equal(seen.size, 500);
  });

  test("hashing is deterministic, or nothing could ever be looked up", () => {
    const minted = createSchedulingToken();
    assert.equal(hashToken(minted.token), hashToken(minted.token));
  });

  test("a hash in an unknown format is refused rather than trusted", () => {
    const minted = createSchedulingToken();
    for (const stored of [minted.token, "", "md5$deadbeef", "nonsense"]) {
      assert.equal(tokenMatches(minted.token, stored), false, stored);
    }
  });

  test("anything that could not have come from us is rejected cheaply", () => {
    for (const value of ["", "abc", "Z".repeat(64), null, undefined, 42, {}]) {
      assert.equal(isWellFormedToken(value), false, String(value));
    }
  });

  test("it expires", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const minted = createSchedulingToken(now);
    const days = (minted.expiresAt.getTime() - now.getTime()) / 86_400_000;
    assert.equal(days, TOKEN_LIFETIME_DAYS);
    assert.ok(minted.expiresAt > now);
  });
});

describe("the peppered form", () => {
  /*
    Exercised by setting the secret around the call, because that is the only
    difference between the two algorithms and the fallback has to keep working
    for tokens minted before a secret existed.
  */
  function withSecret<T>(secret: string | undefined, run: () => T): T {
    const previous = process.env.SCHEDULING_TOKEN_SECRET;
    if (secret === undefined) delete process.env.SCHEDULING_TOKEN_SECRET;
    else process.env.SCHEDULING_TOKEN_SECRET = secret;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.SCHEDULING_TOKEN_SECRET;
      else process.env.SCHEDULING_TOKEN_SECRET = previous;
    }
  }

  test("a configured secret produces an HMAC hash", () => {
    const minted = withSecret("a-test-secret", () => createSchedulingToken());
    assert.match(minted.tokenHash, /^hmac\$/);
    assert.equal(
      withSecret("a-test-secret", () => tokenMatches(minted.token, minted.tokenHash)),
      true,
    );
  });

  test("an HMAC hash cannot be verified once the secret is gone", () => {
    // The point of a pepper: the database alone is not enough.
    const minted = withSecret("a-test-secret", () => createSchedulingToken());
    assert.equal(
      withSecret(undefined, () => tokenMatches(minted.token, minted.tokenHash)),
      false,
    );
  });

  test("tokens minted before a secret existed still verify after one is added", () => {
    const legacy = withSecret(undefined, () => createSchedulingToken());
    assert.match(legacy.tokenHash, /^sha256\$/);
    assert.equal(
      withSecret("a-new-secret", () => tokenMatches(legacy.token, legacy.tokenHash)),
      true,
    );
  });

  test("the same secret gives the same hash, a different one does not", () => {
    const minted = withSecret("secret-one", () => createSchedulingToken());
    assert.equal(
      withSecret("secret-one", () => hashToken(minted.token)),
      minted.tokenHash,
    );
    assert.notEqual(
      withSecret("secret-two", () => hashToken(minted.token)),
      minted.tokenHash,
    );
  });
});

describe("idempotency keys", () => {
  test("a key is namespaced by organisation", () => {
    /*
      `job.idempotency_key` is unique across the whole table. An unscoped key
      from one agency could collide with another's and hand back a job they may
      not see, so the organisation is part of the key.
    */
    const key = submissionIdempotencyKey("org-a", "submission-1");
    assert.equal(key.includes("org-a"), true);
    assert.equal(key.includes("submission-1"), true);
  });

  test("the same submission from two agencies cannot collide", () => {
    assert.notEqual(
      submissionIdempotencyKey("org-a", "same-key"),
      submissionIdempotencyKey("org-b", "same-key"),
    );
  });

  test("the same submission twice gives the same key", () => {
    assert.equal(
      submissionIdempotencyKey("org-a", "submission-1"),
      submissionIdempotencyKey("org-a", "submission-1"),
    );
  });

  test("it is distinguishable from a website booking's key", () => {
    // Website bookings key on the browser's own idempotency key, unprefixed.
    assert.match(submissionIdempotencyKey("org-a", "k"), /^portal:/);
  });
});

describe("the price that gets frozen onto the job", () => {
  const AGREEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  /** Deliberately not BSCJ's real figures, which are not approved. */
  const LINES = [
    {
      id: "line-1",
      productId: "cp12",
      tierMinJobs: 75,
      tierMaxJobs: 99,
      unitPricePence: 3999,
    },
  ];

  /** The same composition `createAgentJob` performs. */
  function priceFor(
    productId: "cp12" | "boiler-service" | "cp12-boiler-service",
    applianceCount: number,
    agreement?: { agreementId: string; lines: typeof LINES; committedJobs: number },
  ) {
    const product = products[productId];
    const resolved = resolvePrice({
      productId,
      agreementId: agreement?.agreementId ?? null,
      lines: agreement?.lines,
      committedJobs: agreement?.committedJobs ?? null,
    });
    const breakdown = calculatePrice(applianceCount, productId);
    return buildPriceSnapshot({
      resolved,
      applianceCount: product.appliancePricing ? breakdown.applianceCount : null,
      extraAppliances: breakdown.extraAppliances,
      extraAppliancePence: Math.round(product.extraAppliancePrice * 100),
    });
  }

  test("with no agreement, an agency pays the published list price", () => {
    const snapshot = priceFor("cp12", 1);
    assert.equal(snapshot.source, "list");
    assert.equal(snapshot.unitPricePence, 4500);
    assert.equal(snapshot.totalPence, 4500);
    assert.equal(snapshot.agreementId, null);
  });

  test("with an applicable agreement, the agreed rate applies", () => {
    const snapshot = priceFor("cp12", 1, {
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 80,
    });
    assert.equal(snapshot.source, "agreement");
    assert.equal(snapshot.unitPricePence, 3999);
    assert.equal(snapshot.agreementId, AGREEMENT);
    assert.deepEqual(snapshot.tier, { minJobs: 75, maxJobs: 99 });
  });

  test("a commitment outside every band falls back to list, not to the nearest", () => {
    const snapshot = priceFor("cp12", 1, {
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 10,
    });
    assert.equal(snapshot.source, "list");
    assert.equal(snapshot.unitPricePence, 4500);
  });

  test("extra appliances are charged on the agreed rate, not the list price", () => {
    const snapshot = priceFor("cp12", 5, {
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 80,
    });
    assert.equal(snapshot.extraAppliances, 2);
    assert.equal(snapshot.extraChargePence, 3000);
    assert.equal(snapshot.totalPence, 3999 + 3000);
  });

  test("a service that is not priced by appliance ignores the count entirely", () => {
    const one = priceFor("boiler-service", 1);
    const nine = priceFor("boiler-service", 9);
    assert.equal(one.totalPence, 6000);
    assert.equal(nine.totalPence, 6000);
    assert.equal(nine.applianceCount, null);
    assert.equal(nine.extraChargePence, 0);
  });

  test("the snapshot total is the figure the job is written with", () => {
    // The invariant an invoice depends on: the frozen total must equal what
    // the agency was quoted, or an invoice would disagree with the portal.
    for (const count of [1, 3, 4, 8]) {
      const snapshot = priceFor("cp12", count);
      assert.equal(snapshot.totalPence, calculatePrice(count, "cp12").total * 100);
    }
  });
});

describe("what job creation is not allowed to take from the client", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/lib/jobs/create-agent-job.ts"),
    "utf8",
  );
  const action = readFileSync(
    path.resolve(process.cwd(), "src/app/(portal)/portal/jobs/actions.ts"),
    "utf8",
  );

  test("the module is server-only and reads no form", () => {
    assert.match(source, /import "server-only"/);
    assert.equal(/FormData/.test(source), false);
    assert.equal(/form\.get\(/.test(source), false);
  });

  test("there is no parameter for a price, status, reference or organisation", () => {
    const input = source.slice(
      source.indexOf("export type CreateAgentJobInput"),
      source.indexOf("export type CreateAgentJobResult"),
    );
    for (const forbidden of [
      "price",
      "Price",
      "reference",
      "lifecycleStatus",
      "status",
      "organisationId",
      "snapshot",
      "Snapshot",
    ]) {
      assert.equal(
        input.includes(forbidden),
        false,
        `the input accepts ${forbidden} from the caller`,
      );
    }
  });

  test("the organisation is the first argument, and every write carries it", () => {
    assert.match(
      source,
      /export async function createAgentJob\(\s*organisationId: string/,
    );
    assert.match(source, /agentOrganisationId: organisationId/);
  });

  test("the property is re-read under the organisation before anything is written", () => {
    assert.match(source, /eq\(properties\.agentOrganisationId, organisationId\)/);
    assert.match(source, /return \{ status: "not_found" \}/);
  });

  test("the action verifies the session before it reads a field", () => {
    const guard = action.indexOf("requireAgent()");
    const firstRead = action.indexOf("form.get(");
    assert.ok(guard > -1, "the action does not verify the session");
    assert.ok(guard < firstRead, "the action reads the form before the guard");
  });

  test("the action never reads an organisation from the form", () => {
    assert.equal(/form\.get\(["']organisationId["']\)/.test(action), false);
    assert.equal(/agentOrganisationId/.test(action), false);
    assert.match(action, /session\.organisationId/);
  });

  test("the action never reads a price from the form", () => {
    for (const forbidden of ["price", "Price", "totalPence"]) {
      assert.equal(
        action.includes(`form.get("${forbidden}`),
        false,
        `the action reads ${forbidden} from the form`,
      );
    }
  });
});

describe("job creation is not invoice creation", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/lib/jobs/create-agent-job.ts"),
    "utf8",
  );

  test("no invoice number is allocated", () => {
    // A draft that is abandoned must not consume a number the business then
    // has to explain the absence of.
    assert.equal(source.includes("allocateInvoiceNumber"), false);
    assert.equal(source.includes("invoice_number_seq"), false);
    assert.equal(/invoices/.test(source), false);
  });

  test("a job reference is not an invoice number", () => {
    // Both carry the BSCJ- prefix; generation refuses an all-digit reference
    // so the two formats can never be confused.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const reference = generateJobReference();
      assert.equal(isJobReference(reference), true);
      assert.equal(isInvoiceNumber(reference), false);
    }
  });
});
