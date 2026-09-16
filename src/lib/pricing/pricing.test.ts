import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VOLUME_TIERS,
  describeTier,
  tierContains,
  tierFor,
  validateTiers,
  type VolumeTier,
} from "./tiers";
import {
  isAgreementEffective,
  listPricePence,
  periodStartFor,
  resolvePrice,
  type AgreementLine,
} from "./resolve";
import {
  buildPriceSnapshot,
  invoiceablePence,
  parsePriceSnapshot,
  PRICE_SNAPSHOT_VERSION,
} from "./snapshot";
import { calculatePrice } from "@/lib/booking/pricing";
import { products } from "@/lib/booking/products";

/**
 * Agent pricing.
 *
 * Two properties matter more than the arithmetic: the published consumer
 * prices are never touched by anything an agency negotiates, and a price once
 * agreed on a job cannot be changed by a later configuration change.
 */

const AGREEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Deliberately not BSCJ's real figures, which have not been approved. */
const LINES: AgreementLine[] = [
  {
    id: "line-small",
    productId: "cp12",
    tierMinJobs: 1,
    tierMaxJobs: 14,
    unitPricePence: 4500,
  },
  {
    id: "line-large",
    productId: "cp12",
    tierMinJobs: 75,
    tierMaxJobs: 99,
    unitPricePence: 3999,
  },
  {
    id: "line-bundle",
    productId: "cp12-boiler-service",
    tierMinJobs: 75,
    tierMaxJobs: null,
    unitPricePence: 8000,
  },
];

describe("volume tiers", () => {
  test("the intended band structure is the default offered", () => {
    assert.deepEqual(DEFAULT_VOLUME_TIERS, [
      { minJobs: 1, maxJobs: 14 },
      { minJobs: 15, maxJobs: 29 },
      { minJobs: 30, maxJobs: 44 },
      { minJobs: 45, maxJobs: 59 },
      { minJobs: 60, maxJobs: 74 },
      { minJobs: 75, maxJobs: 99 },
      { minJobs: 100, maxJobs: null },
    ]);
  });

  test("no price appears anywhere in the band structure", () => {
    // Bands are structure; prices are data. A figure here would be exactly the
    // hard-coding the design exists to avoid.
    for (const tier of DEFAULT_VOLUME_TIERS) {
      assert.deepEqual(Object.keys(tier).sort(), ["maxJobs", "minJobs"]);
    }
  });

  test("bounds are inclusive at both ends", () => {
    const tier: VolumeTier = { minJobs: 15, maxJobs: 29 };
    assert.equal(tierContains(tier, 14), false);
    assert.equal(tierContains(tier, 15), true);
    assert.equal(tierContains(tier, 29), true);
    assert.equal(tierContains(tier, 30), false);
  });

  test("an open-ended band has no upper limit", () => {
    const tier: VolumeTier = { minJobs: 100, maxJobs: null };
    assert.equal(tierContains(tier, 100), true);
    assert.equal(tierContains(tier, 100_000), true);
  });

  test("every volume from one upwards lands in exactly one default band", () => {
    for (const volume of [1, 14, 15, 44, 59, 74, 75, 99, 100, 5000]) {
      const matches = DEFAULT_VOLUME_TIERS.filter((tier) =>
        tierContains(tier, volume),
      );
      assert.equal(matches.length, 1, `${volume} matched ${matches.length} bands`);
    }
  });

  test("a commitment of nothing matches no band, and that is a real answer", () => {
    // The caller charges list rather than guessing a tier.
    assert.equal(tierFor(0), null);
  });

  test("the default structure has no gaps or overlaps", () => {
    assert.deepEqual(validateTiers(DEFAULT_VOLUME_TIERS), []);
  });

  test("an overlap is refused, because it makes a price ambiguous", () => {
    const problems = validateTiers([
      { minJobs: 1, maxJobs: 20 },
      { minJobs: 15, maxJobs: 30 },
    ]);
    assert.equal(problems.some((problem) => problem.kind === "overlap"), true);
  });

  test("a gap is refused, because it makes a price unresolvable", () => {
    const problems = validateTiers([
      { minJobs: 1, maxJobs: 14 },
      { minJobs: 20, maxJobs: 30 },
    ]);
    assert.equal(problems.some((problem) => problem.kind === "gap"), true);
  });

  test("an open-ended band that is not last swallows everything after it", () => {
    const problems = validateTiers([
      { minJobs: 1, maxJobs: null },
      { minJobs: 20, maxJobs: 30 },
    ]);
    assert.equal(problems.some((problem) => problem.kind === "overlap"), true);
  });

  test("nonsense bounds are refused", () => {
    assert.equal(
      validateTiers([{ minJobs: 30, maxJobs: 10 }]).some(
        (problem) => problem.kind === "invalid",
      ),
      true,
    );
  });

  test("bands describe themselves for an admin screen", () => {
    assert.equal(describeTier({ minJobs: 15, maxJobs: 29 }), "15–29 jobs");
    assert.equal(describeTier({ minJobs: 100, maxJobs: null }), "100+ jobs");
  });
});

describe("resolving what an organisation pays", () => {
  test("no agreement means the published list price", () => {
    /*
      The fallback that makes this mechanism safe to ship before a single tier
      figure has been approved.
    */
    const resolved = resolvePrice({ productId: "cp12" });
    assert.equal(resolved.source, "list");
    assert.equal(resolved.unitPricePence, 4500);
    assert.equal(resolved.agreementId, null);
  });

  test("the list price is the registry's, in pence", () => {
    assert.equal(listPricePence("cp12"), products.cp12.price * 100);
    assert.equal(
      listPricePence("boiler-service"),
      products["boiler-service"].price * 100,
    );
    assert.equal(
      listPricePence("cp12-boiler-service"),
      products["cp12-boiler-service"].price * 100,
    );
  });

  test("the committed volume selects the band", () => {
    const small = resolvePrice({
      productId: "cp12",
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 10,
    });
    assert.equal(small.source, "agreement");
    assert.equal(small.unitPricePence, 4500);
    assert.equal(small.agreementLineId, "line-small");

    const large = resolvePrice({
      productId: "cp12",
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 80,
    });
    assert.equal(large.unitPricePence, 3999);
    assert.equal(large.agreementLineId, "line-large");
    assert.deepEqual(large.tier, { minJobs: 75, maxJobs: 99 });
  });

  test("a volume in no band falls back to list rather than to the nearest", () => {
    // 30 sits in the gap these example lines leave. Guessing at the adjacent
    // band would undercharge or overcharge without anyone deciding to.
    const resolved = resolvePrice({
      productId: "cp12",
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 30,
    });
    assert.equal(resolved.source, "list");
    assert.equal(resolved.unitPricePence, 4500);
  });

  test("a service with no line in the agreement pays list", () => {
    const resolved = resolvePrice({
      productId: "boiler-service",
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 80,
    });
    assert.equal(resolved.source, "list");
    assert.equal(resolved.unitPricePence, 6000);
  });

  test("an administrator's override beats any tier", () => {
    const resolved = resolvePrice({
      productId: "cp12",
      agreementId: AGREEMENT,
      lines: LINES,
      committedJobs: 80,
      overridePricePence: 2500,
      overrideReason: "Goodwill after a missed visit",
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.unitPricePence, 2500);
    assert.equal(resolved.overrideReason, "Goodwill after a missed visit");
  });

  test("a nonsensical override is ignored rather than charged", () => {
    for (const bad of [-1, 12.5, Number.NaN]) {
      const resolved = resolvePrice({
        productId: "cp12",
        overridePricePence: bad,
      });
      assert.equal(resolved.source, "list", String(bad));
    }
  });

  test("a free job is a legitimate override", () => {
    const resolved = resolvePrice({
      productId: "cp12",
      overridePricePence: 0,
      overrideReason: "Rework at our cost",
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.unitPricePence, 0);
  });

  test("missing configuration never throws, and never undercharges", () => {
    for (const input of [
      { productId: "cp12" as const, agreementId: AGREEMENT, lines: [] },
      { productId: "cp12" as const, lines: LINES, committedJobs: 80 },
      { productId: "cp12" as const, agreementId: AGREEMENT, lines: LINES },
    ]) {
      const resolved = resolvePrice(input);
      assert.equal(resolved.source, "list");
      assert.equal(resolved.unitPricePence, resolved.listPricePence);
    }
  });

  test("consumer pricing is untouched by any of this", () => {
    // The public £45 is calculated by the V1 module from the registry, and
    // nothing in this layer is on that path.
    assert.equal(calculatePrice(1, "cp12").total, 45);
    assert.equal(calculatePrice(4, "cp12").total, 60);
    assert.equal(calculatePrice(9, "boiler-service").total, 60);
  });
});

describe("whether an agreement is in force", () => {
  const agreement = {
    status: "active",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-12-31",
  };

  test("inside its dates, and inclusive at both ends", () => {
    assert.equal(isAgreementEffective(agreement, "2026-09-01"), true);
    assert.equal(isAgreementEffective(agreement, "2026-10-15"), true);
    assert.equal(isAgreementEffective(agreement, "2026-12-31"), true);
  });

  test("outside them, no", () => {
    assert.equal(isAgreementEffective(agreement, "2026-08-31"), false);
    assert.equal(isAgreementEffective(agreement, "2027-01-01"), false);
  });

  test("a draft or expired agreement is never in force, whatever its dates", () => {
    for (const status of ["draft", "expired"]) {
      assert.equal(
        isAgreementEffective({ ...agreement, status }, "2026-10-15"),
        false,
        status,
      );
    }
  });

  test("an open-ended agreement has no end", () => {
    assert.equal(
      isAgreementEffective({ ...agreement, effectiveTo: null }, "2030-01-01"),
      true,
    );
  });

  test("a month is identified by its first day", () => {
    assert.equal(periodStartFor("2026-09-16"), "2026-09-01");
    assert.equal(periodStartFor("2026-01-31"), "2026-01-01");
  });
});

describe("the price snapshot on the job", () => {
  const resolved = resolvePrice({
    productId: "cp12",
    agreementId: AGREEMENT,
    lines: LINES,
    committedJobs: 80,
  });

  test("it records the agreed price, the list price and how it was reached", () => {
    const snapshot = buildPriceSnapshot({ resolved });

    assert.equal(snapshot.version, PRICE_SNAPSHOT_VERSION);
    assert.equal(snapshot.unitPricePence, 3999);
    assert.equal(snapshot.listPricePence, 4500);
    assert.equal(snapshot.source, "agreement");
    assert.equal(snapshot.agreementId, AGREEMENT);
    assert.equal(snapshot.committedJobs, 80);
    assert.deepEqual(snapshot.tier, { minJobs: 75, maxJobs: 99 });
  });

  test("a later pricing change cannot alter a job already taken", () => {
    /*
      The whole point. The snapshot is built once and read back; re-resolving
      would re-price historical work at today's rates, which is not an answer
      to "what did we charge in March" but a guess that happens to be right
      until something changes.
    */
    const snapshot = buildPriceSnapshot({ resolved });
    const stored = JSON.parse(JSON.stringify(snapshot));

    const renegotiated = resolvePrice({
      productId: "cp12",
      agreementId: AGREEMENT,
      lines: [{ ...LINES[1], unitPricePence: 2500 }],
      committedJobs: 80,
    });
    assert.equal(renegotiated.unitPricePence, 2500);

    const readBack = parsePriceSnapshot(stored);
    assert.equal(readBack?.unitPricePence, 3999);
    assert.equal(invoiceablePence(readBack!), 3999);
  });

  test("extra appliances are charged on the agreed rate, not on the list price", () => {
    // An agency that negotiated a lower CP12 pays their rate plus the extra,
    // not the public price plus the extra.
    const breakdown = calculatePrice(5, "cp12");
    const snapshot = buildPriceSnapshot({
      resolved,
      applianceCount: breakdown.applianceCount,
      extraAppliances: breakdown.extraAppliances,
      extraAppliancePence: products.cp12.extraAppliancePrice * 100,
    });

    assert.equal(snapshot.extraAppliances, 2);
    assert.equal(snapshot.extraChargePence, 3000);
    assert.equal(snapshot.totalPence, 3999 + 3000);
  });

  test("a service without appliance pricing carries no extra charge", () => {
    const breakdown = calculatePrice(9, "boiler-service");
    const snapshot = buildPriceSnapshot({
      resolved: resolvePrice({ productId: "boiler-service" }),
      applianceCount: breakdown.applianceCount,
      extraAppliances: breakdown.extraAppliances,
      extraAppliancePence: products["boiler-service"].extraAppliancePrice * 100,
    });

    assert.equal(snapshot.extraChargePence, 0);
    assert.equal(snapshot.totalPence, 6000);
  });

  test("it survives a round trip through jsonb", () => {
    const snapshot = buildPriceSnapshot({ resolved, applianceCount: 3 });
    const readBack = parsePriceSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.deepEqual(readBack, snapshot);
  });

  test("an unreadable snapshot is null, not a plausible wrong price", () => {
    // A jsonb column hands back whatever was put in it, including something
    // written by an older version of this code.
    for (const value of [
      null,
      undefined,
      "£45",
      42,
      {},
      { productId: "nonsense", unitPricePence: 1, totalPence: 1, source: "list" },
      { productId: "cp12", unitPricePence: 1, totalPence: 1, source: "magic" },
      { productId: "cp12", totalPence: 1, source: "list" },
    ]) {
      assert.equal(parsePriceSnapshot(value), null, JSON.stringify(value));
    }
  });
});
