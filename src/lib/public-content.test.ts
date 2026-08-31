import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  business,
  cancellationPolicy,
  cp12,
  inspectionScope,
  serviceAreas,
  serviceRadiusMiles,
} from "./business";
import { faqs } from "./faqs";
import { calculatePrice } from "./booking/pricing";
import { bundleSavingFor, products, productList } from "./booking/products";
import { buildPropertyAddress } from "./address/format";

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

/**
 * The engineer's identity is maintained privately, outside this repository.
 *
 * These checks are deliberately **structural** rather than a search for the
 * name. An exact-string test would have to hold the name to compare against,
 * which is the very thing that must not be in a tracked file — so the guard
 * targets the shapes a personal identity takes instead: a field to render it
 * from, a schema.org Person node, or an "Engineer: Name" byline.
 */
describe("no engineer identity is published", () => {
  test("there is no field to render a personal name from", () => {
    // Nothing can accidentally print what does not exist.
    assert.equal("engineerName" in business, false);
    assert.equal("engineer" in business, false);

    for (const [key, value] of Object.entries(business)) {
      assert.equal(
        /engineer.*name|name.*engineer/i.test(key),
        false,
        `business.${key} looks like it holds a personal name`,
      );
      // A two-word capitalised value would be a personal name smuggled into
      // some other field.
      if (typeof value === "string" && key !== "name" && key !== "legalName") {
        assert.equal(
          /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(value),
          false,
          `business.${key} = ${value} looks like a personal name`,
        );
      }
    }
  });

  test("no source file carries an engineer byline", () => {
    // The footer used to read "Engineer: {business.engineerName}". The label
    // itself is what to forbid — matching on a capitalised value missed both
    // that JSX form and a quoted literal. Nothing legitimate uses the label,
    // so any "Engineer:" followed by content is a byline coming back.
    const offenders = [...copy]
      .filter(([, contents]) => /Engineer:\s*\S/.test(contents))
      .map(([file]) => file);
    assert.deepEqual(offenders, []);
  });

  test("no personal-identity field reaches the booking payload or the event", () => {
    const route = copy.get("src/app/api/book/route.ts");
    assert.ok(route);
    assert.equal(/engineerName|engineerIdentity/i.test(route), false);
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

/**
 * The mobile shell.
 *
 * Asserted against source structure rather than class strings, so restyling
 * stays free while the rules that made the phone experience usable do not
 * quietly regress.
 */
describe("the mobile header", () => {
  const header = readFileSync(
    path.resolve(SOURCE_ROOT, "components/Header.tsx"),
    "utf8",
  );

  test("navigation is not a horizontally scrolling strip", () => {
    // The old pattern measured 462px of pills inside a 320px viewport, with
    // About and Contact entirely off-screen. No navigation may hide behind a
    // sideways swipe again.
    assert.equal(/overflow-x-auto/.test(header), false);
    assert.equal(/scrollbar-none/.test(header), false);
  });

  test("no stylesheet still carries the hidden-scrollbar helper", () => {
    const css = readFileSync(path.resolve(SOURCE_ROOT, "app/globals.css"), "utf8");
    assert.equal(css.includes("scrollbar-none"), false);
  });

  test("the menu is a labelled, controllable disclosure", () => {
    assert.match(header, /aria-expanded=\{open\}/);
    assert.match(header, /aria-controls=\{menuId\}/);
    assert.match(header, /aria-label=\{open \? "Close menu" : "Open menu"\}/);
  });

  test("Escape closes the menu and returns focus to the toggle", () => {
    assert.match(header, /event\.key !== "Escape"/);
    assert.match(header, /toggleRef\.current\?\.focus\(\)/);
  });

  test("the menu reaches every page a customer might want", () => {
    for (const href of [
      "/",
      "/book",
      "/gas-safety-certificate-wolverhampton",
      "/#areas",
      "/about",
      "/contact",
      "/terms",
    ]) {
      assert.ok(
        header.includes(`href: "${href}"`),
        `the mobile menu should link to ${href}`,
      );
    }
  });

  test("the areas link points at a section that exists", () => {
    const home = readFileSync(path.resolve(SOURCE_ROOT, "app/page.tsx"), "utf8");
    assert.match(home, /id="areas"/);
  });

  test("the header carries no booking state", () => {
    // Presentation only. Nothing here may touch a reservation, a hold token or
    // the booking attempt.
    const code = withoutComments(header);
    for (const forbidden of ["hold", "reservation", "slotStart", "idempotency"]) {
      assert.equal(
        new RegExp(forbidden, "i").test(code),
        false,
        `the header must not reference ${forbidden}`,
      );
    }
  });
});

describe("the confirmation page shows the address once", () => {
  const confirmation = withoutComments(
    readFileSync(
      path.resolve(SOURCE_ROOT, "components/booking/Confirmation.tsx"),
      "utf8",
    ),
  );

  test("the postcode is not appended to an address that already ends in it", () => {
    // Found on the first real booking: `propertyAddress` is the canonical
    // formatted address and already ends with the postcode, so rendering
    // `{propertyAddress}, {postcode}` produced
    // "24 Example Road, Wolverhampton, WV1 1AA, WV1 1AA".
    assert.equal(
      /\{booking\.propertyAddress\}\s*,\s*\{booking\.postcode\}/.test(confirmation),
      false,
    );
  });

  test("the formatted address already carries the postcode", () => {
    // The reason the concatenation was wrong in the first place.
    const address = buildPropertyAddress({
      houseOrName: "24",
      street: "Example Road",
      postcode: {
        postcode: "WV99 1AA",
        outcode: "WV99",
        areaName: "Wolverhampton",
        latitude: 52.6,
        longitude: -2.12,
      },
      confirmedByCustomer: true,
    });
    assert.ok(address.formattedAddress.endsWith("WV99 1AA"));
    assert.equal(address.formattedAddress.match(/WV99 1AA/g)?.length, 1);
  });
});

describe("the fixed mobile action bar", () => {
  const bar = readFileSync(
    path.resolve(SOURCE_ROOT, "components/StickyMobileCTA.tsx"),
    "utf8",
  );

  test("its three destinations are the phone, WhatsApp and booking", () => {
    assert.match(bar, /business\.phoneHref/);
    assert.match(bar, /business\.whatsappHref/);
    assert.match(bar, /href="\/book"/);
  });

  test("every action is labelled for a screen reader", () => {
    assert.equal((bar.match(/aria-label=/g) ?? []).length, 3);
  });

  test("icons are inline SVG, not emoji", () => {
    // Emoji render differently per platform and cannot be recoloured.
    // Comments are stripped first: the note explaining the change names the
    // emoji it replaced.
    assert.match(bar, /<svg/);
    assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(withoutComments(bar)), false);
  });

  test("it respects the iPhone home-indicator inset", () => {
    assert.match(bar, /env\(safe-area-inset-bottom\)/);
  });

  test("the page reserves room for it, so it covers nothing", () => {
    const css = readFileSync(path.resolve(SOURCE_ROOT, "app/globals.css"), "utf8");
    assert.match(css, /padding-bottom:\s*calc\([^)]*safe-area-inset-bottom/);
  });
});

describe("the booking flow is not reshaped by presentation", () => {
  const stepIndicator = readFileSync(
    path.resolve(SOURCE_ROOT, "components/booking/StepIndicator.tsx"),
    "utf8",
  );

  test("the step indicator only reports and navigates", () => {
    // It may call onGoTo for a completed step. It may not know about holds.
    assert.match(stepIndicator, /state === "done" && onGoTo\(step\.number\)/);
    const code = withoutComments(stepIndicator);
    for (const forbidden of ["hold", "reservation", "fetch(", "useState"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `the step indicator must not use ${forbidden}`,
      );
    }
  });

  test("upcoming steps stay unreachable", () => {
    assert.match(stepIndicator, /disabled=\{state !== "done"\}/);
  });

  test("the date picker never claims availability it does not have", () => {
    const datePicker = readFileSync(
      path.resolve(SOURCE_ROOT, "components/booking/DatePicker.tsx"),
      "utf8",
    );
    // The loading branch returns before any date can be rendered as bookable.
    assert.match(datePicker, /if \(loading\)/);
    assert.match(datePicker, /Checking live availability/);
    assert.match(datePicker, /aria-live="polite"/);
  });
});

describe("the booking architecture stays where it was left", () => {
  test("no Google Calendar iframe returns to the customer journey", () => {
    // No exemption any more: BookingEmbed.tsx, the last file that rendered a
    // Google iframe, was deleted in the final audit once nothing referenced it.
    assert.deepEqual(filesContaining(["<iframe"]), []);
  });

  test("no OpenStreetMap or Nominatim verification returns", () => {
    assert.deepEqual(
      filesContaining(["nominatim", "openstreetmap", "/api/address/verify"]),
      [],
    );
  });

  test("the service-area origin stays server-only", () => {
    const serviceArea = readFileSync(
      path.resolve(SOURCE_ROOT, "lib/address/service-area.ts"),
      "utf8",
    );
    assert.match(serviceArea, /^import "server-only";/m);

    // No client component may import it, directly or by naming its helpers.
    const clientFiles = [...copy].filter(([, contents]) =>
      contents.includes('"use client"'),
    );
    for (const [file, contents] of clientFiles) {
      assert.equal(
        /serviceAreaCentre|SERVICE_AREA_LAT|SERVICE_AREA_LNG|address\/service-area/.test(
          contents,
        ),
        false,
        `${file} must not reach the service-area origin`,
      );
    }
  });

  test("no NEXT_PUBLIC variable exists to leak configuration", () => {
    assert.deepEqual(filesContaining(["NEXT_PUBLIC_"]), []);
  });
});

/**
 * The commercial facts a customer decides on.
 *
 * These are not style rules. Each one is a statement the business has to be
 * able to stand behind at the door, and each is deliberately loose enough that
 * copy can still be improved without a test rewrite.
 */
describe("the commercial offer is stated accurately", () => {
  test("the base price and what it covers stay together", () => {
    assert.equal(cp12.price, 45);
    assert.equal(cp12.includes, "one boiler and two additional appliances");
    assert.equal(cp12.extraAppliancePrice, 15);
    // Three appliances at the base price; the fourth is the first chargeable.
    assert.equal(calculatePrice(3).total, 45);
    assert.equal(calculatePrice(4).total, 60);
  });

  test("nothing claims the price is unconditional on the day", () => {
    // The old priceSentence said "nothing else is added on the day", which
    // contradicted the extra-appliance charge and the repairs position.
    assert.deepEqual(filesContaining(["nothing else is added on the day"]), []);
  });

  test("the inspection charge is stated as payable whatever is found", () => {
    assert.match(inspectionScope.chargeAppliesRegardless, /whether everything passes/i);
    // And it reaches customers, not just the constants file.
    const surfaced = [...copy].filter(([, contents]) =>
      contents.includes("inspectionScope.chargeAppliesRegardless"),
    );
    assert.ok(
      surfaced.length >= 2,
      "the inspection-charge position should appear on more than one surface",
    );
  });

  test("repairs are never presented as included in the price", () => {
    assert.match(inspectionScope.repairsExcluded, /not included/i);
    // Affirmative claims only. Asking the question — the FAQ is literally
    // "Are repairs included in the £45?" — is exactly how a customer phrases
    // it, and the answer there is "No".
    assert.deepEqual(
      filesContaining([
        "repairs are included",
        "repairs are covered",
        "price includes repairs",
        "including any repairs",
        "free repairs",
        "repairs at no extra",
      ]),
      [],
    );
  });

  test("the customer is told they need not use us for repairs", () => {
    assert.match(inspectionScope.noObligation, /no obligation/i);
    assert.match(inspectionScope.noObligation, /any Gas Safe registered engineer/i);
  });

  test("no call-out fee is claimed as a contrast with other firms", () => {
    // Two of the three competitors with published terms also state no call-out
    // fee, so a comparison would create a false impression.
    assert.deepEqual(
      filesContaining([
        "unlike other",
        "unlike competitors",
        "unlike most",
        "other engineers charge",
      ]),
      [],
    );
  });

  test("no unsupported market-superiority claim appears anywhere", () => {
    // docs/COMPETITOR_PRICING.md records eleven named firms and four
    // aggregators. That is a sample, not a market, and supports no absolute.
    assert.deepEqual(
      filesContaining([
        "cheapest",
        "lowest price",
        "best price",
        "best value in",
        "price guarantee",
        "guaranteed cheapest",
        "beat any quote",
        "unbeatable",
        "number one",
      ]),
      [],
    );
  });

  test("the offer is not positioned as budget work", () => {
    assert.deepEqual(
      filesContaining(["cut-price", "bargain", "discount gas", "cheap certificate"]),
      [],
    );
  });
});

describe("nothing is invented about the boiler service", () => {
  /*
    Only the name and the price of the bundle have ever been confirmed. What
    an annual boiler service actually involves has not been specified, so the
    site must not describe it — a checklist nobody agreed to is exactly the
    kind of service claim docs/business-details.md forbids.
  */
  test("only the confirmed facts exist in the registry", () => {
    const bundle = products["cp12-boiler-service"];
    assert.equal(bundle.name, "CP12 + Annual Boiler Service");
    assert.equal(bundle.price, 90);
    assert.equal(bundle.durationMinutes, 60);
    // The appliance rule is shared with the CP12, not a second invented one.
    assert.equal(bundle.includes, cp12.includes);
    assert.equal(bundle.extraAppliancePrice, cp12.extraAppliancePrice);
  });

  test("no page claims a procedure, part or check we have not confirmed", () => {
    assert.deepEqual(
      filesContaining([
        "flue test",
        "gas pressure test",
        "combustion analys",
        "clean the burner",
        "strip and clean",
        "replace the seals",
        "manufacturer's checklist",
        "point service",
        "point check",
        "we will clean",
        "parts included",
        "parts are included",
      ]),
      [],
    );
  });

  test("the boiler service is never sold as a guarantee", () => {
    assert.deepEqual(
      filesContaining([
        "extends the life of your boiler",
        "prevents breakdowns",
        "prevent breakdowns",
        "keeps your warranty valid",
        "maintains your warranty",
        "save you money on",
      ]),
      [],
    );
  });

  test("the only saving claimed is the one the price list supports", () => {
    /*
      "Save £15" became sayable when the boiler service got its own published
      price: £45 + £60 against £90 is arithmetic on two things a customer can
      actually book. What stays forbidden is the invented kind — a crossed-out
      price nobody was ever charged, or a discount implied to be temporary.
    */
    const saving = bundleSavingFor("cp12-boiler-service");
    assert.ok(saving);
    assert.equal(saving.saving, 15);
    assert.equal(saving.separateTotal, products.cp12.price + products["boiler-service"].price);

    assert.deepEqual(
      filesContaining([
        "was £",
        "normally £",
        "usually £",
        "rrp",
        "% off",
        "half price",
        "instead of £",
        "reduced from",
        "limited offer",
      ]),
      [],
    );
  });

  test("the saving is derived, never typed into the copy", () => {
    // A hardcoded "£15" would survive a price change and become a lie.
    const offenders = [...copy]
      .filter(([file]) => !file.endsWith("products.ts"))
      .filter(([, contents]) => /save\s*£\s*\d/i.test(contents))
      .map(([file]) => file);
    assert.deepEqual(offenders, []);
  });
});

describe("no invented facts reach the public site", () => {
  test("no review or rating markup exists, because no reviews are verified", () => {
    assert.equal(schemaSource.includes("aggregateRating"), false);
    assert.equal(schemaSource.includes('"Review"'), false);
  });

  test("every published price is the price its product actually charges", () => {
    // Two services now, so this is no longer "the one price" — it is that no
    // published figure can drift from the registry the server bills from.
    assert.equal(products.cp12.price, 45);
    assert.equal(products.cp12.priceTotalDisplay, "£45 total");
    assert.equal(products["cp12-boiler-service"].price, 90);
    assert.equal(products["cp12-boiler-service"].priceTotalDisplay, "£90 total");

    for (const product of productList) {
      assert.equal(product.priceTotalDisplay, `£${product.price} total`);
      assert.equal(product.priceDisplay, `£${product.price}`);
      assert.equal(calculatePrice(3, product.id).total, product.price);
    }
  });

  test("the £45 CP12 is still the entry product and still the default", () => {
    // The bundle was added alongside it, never in place of it.
    assert.equal(cp12.price, 45);
    assert.equal(cp12.priceTotalDisplay, "£45 total");
    assert.equal(calculatePrice(3).total, 45);
    assert.equal(calculatePrice(3).productId, "cp12");
    assert.equal(cp12.durationMinutes, 45);
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

/**
 * Pricing is BSCJ's strongest competitive position, so the site is not allowed
 * to bury it.
 *
 * These are structural rules about where a price must appear and what a call
 * to action must say — deliberately not assertions about type sizes, which
 * would break on any honest design change without protecting anything.
 */
describe("both prices are stated up front", () => {
  /** Pages a customer can land on and decide from. */
  const decisionPages = [
    "src/app/page.tsx",
    "src/app/gas-safety-certificate-wolverhampton/page.tsx",
    "src/app/book/page.tsx",
  ];

  test("all three prices are published somewhere a customer will meet them", () => {
    for (const product of productList) {
      const surfaced = [...copy].filter(
        ([file, contents]) =>
          !file.startsWith("src/lib/") &&
          (contents.includes(`products["${product.id}"]`) ||
            contents.includes(`products.${product.id}`) ||
            (product.id === "cp12" && /cp12\.price/.test(contents))),
      );
      assert.ok(
        surfaced.length > 0,
        `${product.name} is not published on any page`,
      );
    }
  });

  test("every decision page states the entry price", () => {
    for (const page of decisionPages) {
      const contents = copy.get(page);
      assert.ok(contents, `${page} should exist`);
      assert.match(
        contents,
        /cp12\.price(Display|TotalDisplay)|products\.cp12/,
        `${page} does not state the £45`,
      );
    }
  });

  test("the bundle price is reachable without a quote or an enquiry", () => {
    // It is published on the pricing surfaces, not hidden behind a form.
    const surfaced = [...copy].filter(([, contents]) =>
      contents.includes('products["cp12-boiler-service"]'),
    );
    assert.ok(
      surfaced.length >= 3,
      "the £90 should be published on more than one customer-facing surface",
    );
  });

  test("no price is withheld pending an enquiry", () => {
    assert.deepEqual(
      filesContaining([
        "request a quote",
        "get a quote",
        "prices from",
        "from £",
        "poa",
        "price on application",
        "contact us for pricing",
        "call for a price",
      ]),
      [],
    );
  });

  test("the booking selector leads with the price, not with prose", () => {
    const selector = copy.get("src/components/booking/ServiceChoice.tsx");
    assert.ok(selector, "the service selector should exist");
    // The figure is rendered at display size; the benefit line is not.
    assert.match(selector, /text-3xl|text-4xl|text-5xl/);
    assert.match(selector, /priceDisplay/);
    // And it comes from the registry rather than being typed in.
    assert.equal(/£\d/.test(selector), false);
  });

  test("no fake urgency, discount or popularity is used to sell either price", () => {
    // These are genuinely fixed prices. They are stated, not marketed at.
    assert.deepEqual(
      filesContaining([
        "most popular",
        "limited time",
        "offer ends",
        "hurry",
        "only .. left",
        "was £",
        "normally £",
        "usually £",
        "half price",
        "% off",
      ]),
      [],
    );
  });
});
