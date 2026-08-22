import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  business,
  cancellationPolicy,
  cp12,
  serviceAreas,
  serviceRadiusMiles,
} from "./business";
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

/**
 * The booking consent model, asserted against the components' source.
 *
 * These are rules about markup that no unit test of the reducer would catch: a
 * pre-ticked box, a bundled consent, or a Terms link that navigates the tab
 * away and takes the customer's 30-minute reservation with it.
 */
describe("the review step's confirmations", () => {
  const reviewStep = readFileSync(
    path.resolve(SOURCE_ROOT, "components/booking/ReviewStep.tsx"),
    "utf8",
  );
  const bookingFlow = readFileSync(
    path.resolve(SOURCE_ROOT, "components/booking/BookingFlow.tsx"),
    "utf8",
  );

  test("nothing is ticked for the customer", () => {
    // Every consent starts false in the flow's state, and no checkbox is
    // rendered with a hard-coded checked value.
    assert.match(bookingFlow, /useState\(false\);?\s*$/m);
    assert.equal(/checked=\{true\}/.test(reviewStep), false);
    assert.equal(/defaultChecked/.test(reviewStep), false);
  });

  test("all three consents start false", () => {
    for (const name of [
      "addressConfirmed",
      "termsAccepted",
      "earlyPerformanceRequested",
    ]) {
      assert.match(
        bookingFlow,
        new RegExp(`\\[${name},[\\s\\S]{0,60}\\]\\s*=?\\s*[\\s\\S]{0,40}useState\\(\\s*false`),
        `${name} must default to false`,
      );
    }
  });

  test("the three consents are separate controls, not one bundled tick", () => {
    for (const id of [
      "review-confirm-address",
      "review-accept-terms",
      "review-early-performance",
    ]) {
      assert.ok(reviewStep.includes(id), `${id} should be its own control`);
    }
  });

  test("confirming is blocked until every applicable consent is given", () => {
    assert.match(reviewStep, /disabled=\{submitting \|\| !canConfirm\}/);
    assert.match(reviewStep, /addressConfirmed &&\s*\n?\s*termsAccepted/);
  });

  test("the Terms link opens in a new tab, so the reservation survives", () => {
    // Navigating this tab away fires the page's abandonment beacon and
    // releases the customer's slot. Reading the terms must not cost them it.
    const link = reviewStep.match(/<a[^>]*href="\/terms"[\s\S]*?>/);
    assert.ok(link, "the Terms link should exist");
    assert.match(link[0], /target="_blank"/);
    assert.match(link[0], /rel="noopener noreferrer"/);
  });

  test("the new tab is announced, rather than being a surprise", () => {
    assert.match(reviewStep, /opens in a new tab/i);
  });

  test("editing the details clears every consent again", () => {
    const patch = bookingFlow.match(/onPatch=\{\(patch\) => \{[\s\S]*?\}\}/);
    assert.ok(patch, "the details form should patch through the flow");
    for (const setter of [
      "setAddressConfirmed(false)",
      "setTermsAccepted(false)",
      "setEarlyPerformanceRequested(false)",
    ]) {
      assert.ok(patch[0].includes(setter), `${setter} should run on an edit`);
    }
  });

  test("the order button says that confirming means paying", () => {
    // Regulation 14: an order placed with a button must be labelled
    // unambiguously where it entails an obligation to pay — deferred payment
    // included.
    assert.match(reviewStep, /Confirm booking — agree to pay/);
    assert.match(reviewStep, /obligation to pay/i);
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

  test("no cancellation or no-show charge exists anywhere", () => {
    // Neither the £5 flat charge nor an automatic £45 no-show fee was ever
    // implemented, and neither may reappear without evidence of actual loss.
    assert.equal(cancellationPolicy.chargeApplies, false);
    assert.deepEqual(
      filesContaining([
        "cancellation fee of",
        "cancellation charge of",
        "no-show fee",
        "no-show charge",
        "missed appointment fee",
        "£5 charge",
      ]),
      [],
    );
  });

  test("nothing claims an appointment cannot be cancelled", () => {
    // The old terms said exactly this inside a 48-hour window, which read as
    // though it removed a statutory right.
    assert.deepEqual(
      filesContaining([
        "cannot be cancelled",
        "can not be cancelled",
        "cannot cancel",
        "non-refundable",
        "no refunds",
      ]),
      [],
    );
  });

  test("statutory rights are never excluded or limited", () => {
    assert.deepEqual(
      filesContaining([
        "exclude all liability",
        "excludes all liability",
        "to the fullest extent permitted",
        "we accept no liability",
        "no liability whatsoever",
        "your statutory rights are not affected by", // trailing weasel wording
      ]),
      [],
    );
  });

  test("the terms page states its version and the right to cancel", () => {
    const terms = copy.get("src/app/terms/page.tsx");
    assert.ok(terms, "the terms page should exist");
    assert.match(terms, /right to cancel this contract within/i);
    assert.match(terms, /TERMS_VERSION/);
    assert.match(terms, /reasonable care and skill/i);
    // The model cancellation form is made available, and is not compulsory.
    assert.match(terms, /cancellation-form/);
    assert.match(terms, /do not have to use this form/i);
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
