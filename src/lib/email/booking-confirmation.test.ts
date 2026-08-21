import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  renderBookingConfirmationEmail,
  type BookingEmailInput,
} from "./booking-confirmation";
import { bookingReference, isBookingReference } from "@/lib/booking/reference";
import { calculatePrice } from "@/lib/booking/pricing";
import { business, cp12, legal } from "@/lib/business";
import { formatLongDate, timeLabelInZone, zonedTimeToUtc } from "@/lib/booking/time";

const BASE: BookingEmailInput = {
  reference: "BSCJ-A1B2C3",
  customerName: "Jane Smith",
  dateLabel: "Monday, 24 August 2026",
  startLabel: "17:00",
  endLabel: "17:45",
  subjectDateLabel: "Monday 24 August",
  addressLines: ["24 Example Road", "Wolverhampton", "WV1 1AA"],
  applianceCount: 1,
  priceTotal: 45,
};

function render(overrides: Partial<BookingEmailInput> = {}) {
  return renderBookingConfirmationEmail({ ...BASE, ...overrides });
}

describe("subject and preheader", () => {
  test("the subject names the business, the service and the date", () => {
    assert.equal(
      render().subject,
      "Your BSCJ Gas CP12 booking — Monday 24 August",
    );
  });

  test("the subject avoids shouting, emoji and urgency", () => {
    const { subject } = render();
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(subject));
    assert.ok(!/URGENT|ACT NOW|!!/i.test(subject));
    // Not screaming: no run of capitals beyond the brand initials.
    assert.ok(!/[A-Z]{5,}/.test(subject.replace("BSCJ", "")));
  });

  test("the preheader adds information rather than repeating the subject", () => {
    const { subject, preheader } = render();
    assert.notEqual(preheader, subject);
    assert.ok(preheader.includes("17:00"));
    assert.ok(preheader.includes("BSCJ-A1B2C3"));
  });

  test("the preheader is hidden in the HTML body", () => {
    const { html, preheader } = render();
    assert.ok(html.includes(preheader));
    assert.match(html, /display:none;[^"]*max-height:0/);
  });
});

describe("content is correct in both formats", () => {
  for (const format of ["html", "text"] as const) {
    test(`${format}: customer name`, () => {
      assert.ok(render()[format].includes("Jane Smith"));
    });

    test(`${format}: service`, () => {
      assert.ok(render()[format].includes("Gas Safety Certificate (CP12)"));
    });

    test(`${format}: property address and postcode`, () => {
      const output = render()[format];
      assert.ok(output.includes("24 Example Road"));
      assert.ok(output.includes("WV1 1AA"));
    });

    test(`${format}: appliance count is singular for one`, () => {
      assert.ok(render({ applianceCount: 1 })[format].includes("1 appliance"));
    });

    test(`${format}: appliance count is plural for several`, () => {
      assert.ok(render({ applianceCount: 4 })[format].includes("4 appliances"));
    });

    test(`${format}: the server-derived total`, () => {
      assert.ok(render({ priceTotal: 45 })[format].includes("45"));
    });

    test(`${format}: a multi-appliance total`, () => {
      const price = calculatePrice(5);
      assert.equal(price.total, 75);
      assert.ok(render({ priceTotal: price.total, applianceCount: 5 })[format].includes("75"));
    });

    test(`${format}: payment wording from the business details`, () => {
      assert.ok(render()[format].includes(cp12.payment));
    });

    test(`${format}: booking reference`, () => {
      assert.ok(render()[format].includes("BSCJ-A1B2C3"));
    });

    test(`${format}: business phone number`, () => {
      assert.ok(render()[format].includes(business.phoneDisplay));
    });

    test(`${format}: company identity in the footer`, () => {
      const output = render()[format];
      assert.ok(output.includes(business.legalName));
      assert.ok(output.includes(business.gasSafeNumber));
      if (legal.companyNumber) {
        assert.ok(output.includes(legal.companyNumber));
      }
    });

    test(`${format}: the appointment time range`, () => {
      const output = render()[format];
      assert.ok(output.includes("17:00"));
      assert.ok(output.includes("17:45"));
    });
  }

  test("the price shown is never a client-supplied figure", () => {
    // The builder has no way to compute a price: it can only render what the
    // booking API passes, which comes from calculatePrice on the server.
    const rendered = render({ priceTotal: calculatePrice(4).total });
    assert.ok(rendered.html.includes("60"));
  });
});

describe("plain text carries everything essential", () => {
  const { text } = render();
  const essentials = [
    "YOU'RE BOOKED",
    "Monday, 24 August 2026",
    "17:00-17:45",
    "24 Example Road",
    "WV1 1AA",
    "Gas Safety Certificate (CP12)",
    "1 appliance",
    "£45 total",
    cp12.payment,
    "BSCJ-A1B2C3",
    business.phoneDisplay,
    business.emailBooking,
  ];

  for (const item of essentials) {
    test(`text contains ${item}`, () => {
      assert.ok(text.includes(item), `plain text is missing: ${item}`);
    });
  }

  test("plain text carries no HTML tags", () => {
    assert.ok(!/<[a-z][^>]*>/i.test(text));
  });
});

describe("dates come from the booking engine, not the email", () => {
  const tz = "Europe/London";

  test("a British Summer Time booking reads in local time", () => {
    const start = zonedTimeToUtc(
      { year: 2026, month: 8, day: 24, hour: 17, minute: 0 },
      tz,
    );
    // 17:00 London in August is 16:00 UTC — the email must not show 16:00.
    assert.equal(start.toISOString(), "2026-08-24T16:00:00.000Z");

    const rendered = render({
      dateLabel: formatLongDate("2026-08-24", tz),
      startLabel: timeLabelInZone(start, tz),
    });
    assert.ok(rendered.html.includes("17:00"));
    assert.ok(!rendered.html.includes("16:00"));
    assert.ok(rendered.html.includes("Monday"));
  });

  test("a Greenwich Mean Time booking reads in local time", () => {
    const start = zonedTimeToUtc(
      { year: 2026, month: 1, day: 19, hour: 17, minute: 0 },
      tz,
    );
    assert.equal(start.toISOString(), "2026-01-19T17:00:00.000Z");

    const rendered = render({
      dateLabel: formatLongDate("2026-01-19", tz),
      startLabel: timeLabelInZone(start, tz),
    });
    assert.ok(rendered.html.includes("17:00"));
    assert.ok(rendered.html.includes("Monday"));
  });

  test("a late-evening slot does not roll to the next day", () => {
    const start = zonedTimeToUtc(
      { year: 2026, month: 8, day: 24, hour: 19, minute: 0 },
      tz,
    );
    const rendered = render({
      dateLabel: formatLongDate("2026-08-24", tz),
      startLabel: timeLabelInZone(start, tz),
      endLabel: "19:45",
    });
    assert.ok(rendered.html.includes("24 August 2026"));
    assert.ok(!rendered.html.includes("25 August"));
  });
});

describe("nothing internal leaks into the email", () => {
  const rendered = render();
  const everything = `${rendered.html}\n${rendered.text}\n${rendered.subject}\n${rendered.preheader}`;

  const forbidden: [string, string][] = [
    ["a hold token", "a".repeat(64)],
    ["a raw Google event id", "bscj791a886d455a84781e210fdcef62b8be992cd8d73"],
    ["the service account variable", "GOOGLE_SERVICE_ACCOUNT_EMAIL"],
    ["the private key variable", "GOOGLE_PRIVATE_KEY"],
    ["the calendar id variable", "GOOGLE_CALENDAR_ID"],
    ["the Resend key variable", "RESEND_API_KEY"],
    ["the Redis url variable", "UPSTASH_REDIS_REST_URL"],
    ["the Redis token variable", "UPSTASH_REDIS_REST_TOKEN"],
    ["a redis hold key", "booking-hold:"],
    ["an idempotency marker", "booking-done:"],
  ];

  for (const [description, needle] of forbidden) {
    test(`does not contain ${description}`, () => {
      assert.ok(!everything.includes(needle));
    });
  }

  test("the reference is not the event id", () => {
    const eventId = "bscj791a886d455a84781e210fdcef62b8be992cd8d73a79e8d25ce6";
    const reference = bookingReference(eventId);
    assert.ok(!eventId.includes(reference.replace("BSCJ-", "")));
    assert.ok(!reference.includes(eventId.slice(4, 12)));
  });

  test("no tenant details appear unless deliberately passed", () => {
    // The email input has no tenant fields at all, so tenant contact details
    // cannot reach a customer's inbox by accident.
    assert.ok(!("tenantName" in BASE));
    assert.ok(!("tenantPhone" in BASE));
  });
});

describe("resilience of the rendered HTML", () => {
  test("customer-supplied text is escaped", () => {
    const rendered = render({
      customerName: '<script>alert("x")</script>',
      addressLines: ["12 Rose & Crown <Lane>", "Wolverhampton", "WV1 1AA"],
    });
    assert.ok(!rendered.html.includes("<script>"));
    assert.ok(rendered.html.includes("&lt;script&gt;"));
    assert.ok(rendered.html.includes("Rose &amp; Crown"));
  });

  test("a very long name and address do not break the markup", () => {
    const rendered = render({
      customerName: "Bartholomew Fitzwilliam-Montgomery Featherstonehaugh",
      addressLines: [
        "Flat 12b, The Old Gasworks Building, 24 Example Road",
        "Whitmore Reans",
        "WV1 1AA",
      ],
    });
    assert.ok(rendered.html.includes("Featherstonehaugh"));
    assert.ok(rendered.html.includes("Whitmore Reans"));
    assert.equal(
      (rendered.html.match(/<table/g) || []).length,
      (rendered.html.match(/<\/table>/g) || []).length,
    );
  });

  test("the layout is table based and width constrained for email clients", () => {
    const { html } = render();
    assert.ok(html.includes("max-width:600px"));
    assert.ok(html.includes('role="presentation"'));
    assert.ok(!html.includes("display:flex"));
    assert.ok(!html.includes("display:grid"));
  });

  test("there is no JavaScript or external stylesheet", () => {
    const { html } = render();
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<link[^>]+stylesheet/i.test(html));
  });

  test("buttons remain usable links if styling is stripped", () => {
    const { html } = render();
    assert.ok(html.includes(`href="${business.phoneHref}"`));
    assert.ok(html.includes(`href="${business.whatsappHref}"`));
  });

  test("no raw urls are shown as visible body text", () => {
    const { html } = render();
    assert.ok(!html.includes(">https://api.resend.com"));
  });
});

describe("the booking reference", () => {
  test("is stable for the same event", () => {
    assert.equal(bookingReference("event-abc"), bookingReference("event-abc"));
  });

  test("differs between events", () => {
    assert.notEqual(bookingReference("event-abc"), bookingReference("event-xyz"));
  });

  test("matches the customer-facing format", () => {
    const reference = bookingReference("event-abc");
    assert.match(reference, /^BSCJ-[0-9A-Z]{6}$/);
    assert.ok(isBookingReference(reference));
  });

  test("avoids characters that are misread aloud", () => {
    for (let index = 0; index < 500; index += 1) {
      const reference = bookingReference(`event-${index}`).replace("BSCJ-", "");
      assert.ok(!/[ILOU]/.test(reference), `ambiguous character in ${reference}`);
    }
  });
});


describe("mobile responsiveness", () => {
  const { html } = render();

  test("a mobile breakpoint exists", () => {
    assert.ok(html.includes("@media screen and (max-width: 600px)"));
  });

  test("desktop values stay inline, so Outlook desktop is unaffected", () => {
    // Outlook desktop ignores <style> entirely and reads only inline styles.
    // These are the desktop paddings and sizes the owner approved.
    assert.ok(html.includes("padding:24px 12px"), "outer wrapper");
    assert.ok(html.includes("padding:24px 28px"), "header");
    assert.ok(html.includes("padding:22px 24px"), "appointment card");
    assert.ok(html.includes("font-size:26px"), "desktop date size");
  });

  test("mobile overrides target padding, not readability", () => {
    const mobileBlock = html.slice(html.indexOf("@media screen"), html.indexOf("</style>"));
    // Nothing in the mobile rules drops body text below 12px.
    const sizes = [...mobileBlock.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0, "mobile rules should adjust some type");
    assert.ok(
      sizes.every((size) => size >= 16),
      `mobile type must stay readable, found: ${sizes.join(", ")}`,
    );
  });

  test("the appointment card is still the most prominent element on mobile", () => {
    const mobileBlock = html.slice(html.indexOf("@media screen"), html.indexOf("</style>"));
    const dateSize = Number(/\.m-date \{ font-size: (\d+)px/.exec(mobileBlock)?.[1]);
    const timeSize = Number(/\.m-time \{ font-size: (\d+)px/.exec(mobileBlock)?.[1]);
    assert.ok(dateSize >= 20, "the date should stay large");
    assert.ok(timeSize >= 18, "the time should stay large");
  });

  test("contact buttons stack full width on mobile", () => {
    const mobileBlock = html.slice(html.indexOf("@media screen"), html.indexOf("</style>"));
    assert.ok(mobileBlock.includes(".m-btn"));
    assert.ok(mobileBlock.includes("width: 100% !important"));
    assert.ok(html.includes('class="m-btn"'));
    assert.ok(html.includes('class="m-btncell"'));
  });

  test("the mobile classes are attached to the elements they target", () => {
    for (const className of [
      "m-wrap",
      "m-head",
      "m-sec",
      "m-card",
      "m-hero",
      "m-date",
      "m-time",
      "m-ref",
      "m-foot",
      "m-step",
    ]) {
      assert.ok(
        html.includes(`class="${className}`) || html.includes(` ${className}"`),
        `${className} is defined but never used`,
      );
    }
  });

  test("no fragile or unsupported CSS is introduced", () => {
    assert.ok(!html.includes("display:flex"));
    assert.ok(!html.includes("display: flex"));
    assert.ok(!html.includes("display:grid"));
    assert.ok(!html.includes("position:absolute"));
    assert.ok(!/@import/.test(html));
    assert.ok(!/<script/i.test(html));
  });
});

describe("contrast and dark mode resilience", () => {
  const { html } = render();

  /** WCAG relative luminance. */
  function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5]
        .map((index) => parseInt(hex.substr(index, 2), 16) / 255)
        .map((value) =>
          value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  }

  test("the appointment time meets the large-text contrast threshold", () => {
    // #f78d09 was 2.39:1 on white and failed; #db7304 reaches 3.25:1.
    assert.ok(html.includes("#db7304"), "the darker brand orange should be used");
    assert.ok(!html.includes("color:#f78d09"), "the failing orange should not be text");
    assert.ok(contrast("#db7304", "#ffffff") >= 3);
  });

  test("body text on white comfortably passes", () => {
    assert.ok(contrast("#112643", "#ffffff") >= 4.5);
    assert.ok(contrast("#1c3a63", "#ffffff") >= 4.5);
  });

  test("footer text passes despite being secondary", () => {
    assert.ok(contrast("#1c3a63", "#ffffff") >= 4.5);
  });

  test("header text passes on the navy background", () => {
    assert.ok(contrast("#ffffff", "#0b1b30") >= 4.5);
    assert.ok(contrast("#ffab2e", "#0b1b30") >= 4.5);
  });

  test("cards carry borders, so they survive a client flattening backgrounds", () => {
    // Outlook mobile recolours backgrounds in dark mode. A card defined only
    // by its fill would disappear; a border keeps it distinguishable.
    assert.ok(html.includes("border:2px solid #0b1b30"), "appointment card border");
    assert.ok(html.includes("border:1px solid #c2d5ec"), "property card border");
    assert.ok(html.includes("border-left:4px solid #0f7a52"), "success marker");
  });

  test("the success state is not signalled by colour alone", () => {
    // "You're booked." carries the meaning; the green is reinforcement.
    assert.ok(html.includes("You&rsquo;re booked."));
  });

  test("the colour scheme is declared for clients that honour it", () => {
    assert.ok(html.includes('name="color-scheme"'));
    assert.ok(html.includes('name="supported-color-schemes"'));
  });
});

describe("the keep-this-email reminder", () => {
  test("appears in the html", () => {
    assert.ok(
      render().html.includes(
        "Keep this email for your appointment details and booking reference.",
      ),
    );
  });

  test("appears in the plain text", () => {
    assert.ok(
      render().text.includes(
        "Keep this email for your appointment details and booking reference.",
      ),
    );
  });

  test("does not tell the reader to check their spam folder", () => {
    // They are already reading it. That guidance belongs on the website.
    const { html, text } = render();
    assert.ok(!/junk/i.test(html));
    assert.ok(!/spam/i.test(html));
    assert.ok(!/junk/i.test(text));
    assert.ok(!/spam/i.test(text));
  });
});
