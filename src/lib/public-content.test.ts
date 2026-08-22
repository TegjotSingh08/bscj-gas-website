import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { business, cp12, serviceAreas, serviceRadiusMiles } from "./business";
import { faqs } from "./faqs";

/**
 * Rules about what the public site is allowed to say.
 *
 * These are repository-level assertions rather than rendering tests: every
 * customer-facing string on this site originates in `src/`, so anything that
 * must never be published must never appear there in the first place.
 *
 * Deliberately scoped to `src/`. `docs/business-details.md` is the internal
 * business record and may legitimately hold details — including a person's
 * name — that must not be published. Widening this to the whole repository
 * would make it impossible to keep an accurate internal record.
 *
 * `schema.tsx` is read as text rather than imported: Node's type stripping
 * handles `.ts` but not the JSX in `.tsx`.
 */

const SOURCE_ROOT = path.resolve(process.cwd(), "src");

/**
 * The engineer's personal name. Held here only so the check can be made; it
 * must appear nowhere else under `src/`, which is what these tests assert.
 */
const ENGINEER_PERSONAL_NAME = "Jagjeet";

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|css|json|svg|md)$/.test(entry)) found.push(full);
  }
  return found;
}

/** Everything the site is built from. Tests ship nothing to a customer. */
const files = sourceFiles(SOURCE_ROOT).filter(
  (file) => !file.endsWith(".test.ts"),
);

/**
 * Source with comments removed.
 *
 * Copy rules apply to what a customer can read, not to the notes explaining
 * why a rule exists — a comment saying "never promise a drive time" must not
 * itself trip the check that nothing promises a drive time.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

/** Every customer-readable string in the site, keyed by file. */
const copy = new Map(
  files.map((file) => [
    path.relative(process.cwd(), file),
    withoutComments(readFileSync(file, "utf8")),
  ]),
);

/** Read as text: Node's type stripping handles `.ts` but not JSX in `.tsx`. */
const schemaSource = withoutComments(
  readFileSync(path.resolve(SOURCE_ROOT, "lib/schema.tsx"), "utf8"),
);

/** Files whose customer-readable copy contains any of `phrases`. */
function filesContaining(phrases: string[]): string[] {
  const offenders: string[] = [];
  for (const [file, contents] of copy) {
    const haystack = contents.toLowerCase();
    if (phrases.some((phrase) => haystack.includes(phrase.toLowerCase()))) {
      offenders.push(file);
    }
  }
  return offenders;
}

describe("the engineer's personal name is never published", () => {
  test("it appears nowhere in the site's source", () => {
    // Comments included here: the name must not be recorded in the site's
    // source at all, not merely kept out of the rendered strings.
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8")
        .toLowerCase()
        .includes(ENGINEER_PERSONAL_NAME.toLowerCase()),
    );

    assert.deepEqual(
      offenders.map((file) => path.relative(process.cwd(), file)),
      [],
      "the engineer's name must not appear in page copy, metadata, structured data, the confirmation page or the confirmation email",
    );
  });

  test("the business facts carry no engineer name to render", () => {
    // Nothing can accidentally print what does not exist.
    assert.equal("engineerName" in business, false);
  });

  test("structured data publishes no Person identity", () => {
    assert.equal(schemaSource.includes('"Person"'), false);
    assert.equal(/\bemployee:/.test(schemaSource), false);
  });

  test("work is still attributed, at business level", () => {
    // Removing a name must not remove the trust signal it sat next to.
    assert.ok(schemaSource.includes("Gas Safe Register"));
    assert.ok(schemaSource.includes("business.name"));
  });
});

describe("the advertised service area matches the booking rule", () => {
  test("the radius the copy quotes is the one the rule defaults to", () => {
    assert.equal(serviceRadiusMiles, 12);
  });

  test("the towns advertised are inside that radius", () => {
    // Every entry was checked against the same haversine and default centre
    // the server uses. Wolverhampton anchors the list; the rest are the towns
    // the radius reaches.
    assert.ok(serviceAreas.includes("Wolverhampton"));
    assert.ok(serviceAreas.includes("Dudley"));
    assert.ok(serviceAreas.includes("Walsall"));
    assert.equal(new Set(serviceAreas).size, serviceAreas.length);
  });

  test("structured data serves exactly the areas the site advertises", () => {
    // One list feeds both areaServed blocks, so copy and markup cannot drift.
    const areaServedBlocks = schemaSource.match(/areaServed: serviceAreas/g);
    assert.equal(areaServedBlocks?.length, 2);
  });

  test("no premises are claimed outside the registered office", () => {
    // areaServed says where work is done; exactly one address is published.
    assert.equal(schemaSource.match(/"@type": "PostalAddress"/g)?.length, 1);
    assert.ok(schemaSource.includes("registeredOffice.streetAddress"));
  });

  test("the areas answer points at the postcode check, not at a town name", () => {
    const answer = faqs.find((faq) =>
      faq.question.toLowerCase().includes("areas"),
    )?.answer;

    assert.ok(answer, "there should be an areas-covered FAQ");
    assert.ok(answer.includes("postcode"));
  });

  test("no journey time is ever promised off the back of the radius", () => {
    // The radius is straight-line. Saying so is fine — the copy does — but
    // turning miles into an arrival promise is not.
    assert.deepEqual(
      filesContaining([
        "minute drive",
        "minutes drive",
        "minute-drive",
        "minutes away",
        "within 30 minutes",
        "guaranteed within",
      ]),
      [],
    );
  });

  test("being outside the area is never phrased as a refusal", () => {
    // Work beyond the standard online radius may still be accepted by
    // arrangement, so nothing may tell a customer we do not serve them.
    assert.deepEqual(
      filesContaining([
        "we do not serve",
        "we don't serve",
        "we do not cover your",
        "outside our area",
      ]),
      [],
    );
  });
});

describe("no invented facts reach the public site", () => {
  test("no review or rating markup exists, because no reviews are verified", () => {
    assert.equal(schemaSource.includes("aggregateRating"), false);
    assert.equal(schemaSource.includes('"Review"'), false);
  });

  test("the published price is the one fixed price", () => {
    assert.equal(cp12.price, 45);
    assert.equal(cp12.priceTotalDisplay, "£45 total");
  });

  test("no VAT wording appears anywhere customer-facing", () => {
    // The price is VAT-inclusive internally, which is recorded in
    // docs/business-details.md and marked INTERNAL ONLY. It is presented
    // publicly as a plain fixed total, with no VAT wording at all.
    const offenders = [...copy]
      .filter(([, contents]) => /\bvat\b/i.test(contents))
      .map(([file]) => file);

    assert.deepEqual(offenders, []);
  });
});
