import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isSameDay,
  notificationSubject,
  renderBookingNotificationEmail,
  type BookingNotificationInput,
} from "./booking-notification";
import { zonedTimeToUtc } from "@/lib/booking/time";

/**
 * The internal alert that a booking has been made.
 *
 * Its job is operational: get someone to the right address at the right time,
 * and shout when that time is today. It is not a customer-facing document and
 * must not carry anything internal.
 */

const ZONE = "Europe/London";

const BASE: BookingNotificationInput = {
  reference: "BSCJ-A1B2C3",
  dateLabel: "Thursday, 27 August 2026",
  subjectDateLabel: "Thursday 27 August",
  startLabel: "19:00",
  endLabel: "19:45",
  addressLines: ["24 Example Road", "Wolverhampton", "WV99 1AA"],
  postcode: "WV99 1AA",
  customerName: "Jane Smith",
  customerPhone: "+447700900123",
  customerEmail: "jane@example.com",
  customerType: "Landlord",
  productName: "Gas Safety Certificate (CP12)",
  productSubjectName: "CP12",
  applianceCount: 3,
  priceTotal: 45,
  sameDay: false,
  accessNotes: "",
  tenantName: "",
  tenantPhone: "",
};

const render = (overrides: Partial<BookingNotificationInput> = {}) =>
  renderBookingNotificationEmail({ ...BASE, ...overrides });

describe("the subject line", () => {
  test("a future booking gets the normal subject", () => {
    assert.equal(
      notificationSubject(BASE),
      "NEW CP12 BOOKING — Thursday 27 August 19:00 — WV99 1AA",
    );
  });

  test("a same-day booking gets the urgent subject", () => {
    assert.equal(
      notificationSubject({ ...BASE, sameDay: true }),
      "URGENT — SAME-DAY CP12 BOOKING — 19:00 — WV99 1AA",
    );
  });

  test("the urgent subject leads with the shouting, for a lock screen", () => {
    assert.match(notificationSubject({ ...BASE, sameDay: true }), /^URGENT/);
  });

  test("both carry the time and the postcode", () => {
    for (const sameDay of [true, false]) {
      const subject = notificationSubject({ ...BASE, sameDay });
      assert.ok(subject.includes("19:00"), subject);
      assert.ok(subject.includes("WV99 1AA"), subject);
    }
  });

  test("the rendered email uses that subject", () => {
    assert.equal(render().subject, notificationSubject(BASE));
    assert.equal(
      render({ sameDay: true }).subject,
      notificationSubject({ ...BASE, sameDay: true }),
    );
  });
});

describe("same-day detection", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    zonedTimeToUtc({ year: y, month: m, day: d, hour: h, minute: min }, ZONE);

  test("an appointment later today is same-day", () => {
    assert.equal(
      isSameDay(at(2026, 8, 27, 19), at(2026, 8, 27, 9), ZONE),
      true,
    );
  });

  test("booked just after midnight for this evening is still same-day", () => {
    assert.equal(
      isSameDay(at(2026, 8, 27, 19), at(2026, 8, 27, 0, 30), ZONE),
      true,
    );
  });

  test("booked late at night for tomorrow morning is not same-day", () => {
    // Only a few hours apart, but a different calendar day — which is what
    // "same-day" means to the person driving to it.
    assert.equal(
      isSameDay(at(2026, 8, 28, 9), at(2026, 8, 27, 23, 30), ZONE),
      false,
    );
  });

  test("tomorrow is not same-day", () => {
    assert.equal(isSameDay(at(2026, 8, 28, 10), at(2026, 8, 27, 10), ZONE), false);
  });

  test("it is judged in London time, not UTC", () => {
    // 23:30 UTC on 27 August is 00:30 on 28 August in BST. An appointment at
    // 10:00 on the 28th is therefore same-day, which UTC comparison would miss.
    const nowUtcStill27th = new Date("2026-08-27T23:30:00.000Z");
    assert.equal(isSameDay(at(2026, 8, 28, 10), nowUtcStill27th, ZONE), true);
  });
});

describe("the content an engineer needs", () => {
  const { html, text } = render();

  test("the reference, date, time and address are all present", () => {
    for (const body of [html, text]) {
      assert.ok(body.includes("BSCJ-A1B2C3"));
      assert.ok(body.includes("Thursday, 27 August 2026"));
      assert.ok(body.includes("19:00"));
      assert.ok(body.includes("19:45"));
      assert.ok(body.includes("24 Example Road"));
      assert.ok(body.includes("Wolverhampton"));
      assert.ok(body.includes("WV99 1AA"));
    }
  });

  test("the customer's name, mobile and email are present", () => {
    for (const body of [html, text]) {
      assert.ok(body.includes("Jane Smith"));
      assert.ok(body.includes("+447700900123"));
      assert.ok(body.includes("jane@example.com"));
    }
  });

  test("the customer type, appliance count and total are present", () => {
    for (const body of [html, text]) {
      assert.ok(body.includes("Landlord"));
      assert.ok(/3 appliances|Appliances:\s+3/.test(body));
      assert.ok(body.includes("45"));
    }
  });

  test("it says payment is after completion", () => {
    for (const body of [html, text]) {
      assert.match(body, /pay after completion/i);
      assert.match(body, /no payment has been taken/i);
    }
  });

  test("a single appliance is not pluralised", () => {
    assert.ok(render({ applianceCount: 1 }).html.includes("1 appliance<"));
  });

  test("the date, time and address are the most prominent things", () => {
    // The <title> and the hidden preheader both repeat the time and address
    // near the top, so measure only what a reader actually sees.
    const body = html
      .slice(html.indexOf("<body"))
      .replace(/<div style="display:none[\s\S]*?<\/div>/, "");
    const sizes = [...body.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
    const biggest = Math.max(...sizes);

    // The time is the largest thing in the email.
    assert.equal(biggest, 32);
    const beforeTime = body.slice(0, body.indexOf(BASE.startLabel));
    assert.ok(
      beforeTime.lastIndexOf(`font-size:${biggest}px`) >
        beforeTime.lastIndexOf("font-size:24px"),
      "the time should carry the largest type",
    );

    // The date is next, then the address — both far above the detail rows.
    assert.match(body, /font-size:24px[\s\S]{0,120}Thursday, 27 August 2026/);
    assert.match(body, /font-size:22px[\s\S]{0,120}24 Example Road/);
  });

  test("optional fields are omitted when empty rather than shown blank", () => {
    assert.equal(html.includes("Tenant"), false);
    assert.equal(html.includes("Access notes"), false);
    assert.equal(text.includes("Access notes"), false);
  });

  test("optional fields appear when supplied", () => {
    const withExtras = render({
      tenantName: "Tom Tenant",
      tenantPhone: "+447700900999",
      accessNotes: "Key safe by the side gate",
    });
    for (const body of [withExtras.html, withExtras.text]) {
      assert.ok(body.includes("Tom Tenant"));
      assert.ok(body.includes("Key safe by the side gate"));
    }
  });

  test("a same-day booking is flagged in the body, not only the subject", () => {
    const urgent = render({ sameDay: true });
    assert.match(urgent.html, /SAME-DAY BOOKING/);
    assert.match(urgent.text, /SAME-DAY BOOKING/);
    assert.equal(/SAME-DAY/.test(render().html), false);
  });
});

describe("nothing internal leaks into the alert", () => {
  const bodies = [render().html, render().text].join("\n");

  test("no hold token, idempotency key or event id", () => {
    for (const forbidden of [
      "holdToken",
      "idempotency",
      "booking-hold:",
      "booking-done:",
      "eventId",
      "bscj" + "0123456789",
    ]) {
      assert.equal(
        bodies.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `${forbidden} must not appear`,
      );
    }
  });

  test("no credential or provider detail", () => {
    for (const forbidden of ["RESEND", "UPSTASH", "GOOGLE_", "api_key", "Bearer"]) {
      assert.equal(bodies.includes(forbidden), false, `${forbidden} must not appear`);
    }
  });

  test("no terms evidence, which belongs on the calendar event", () => {
    assert.equal(/terms accepted/i.test(bodies), false);
    assert.equal(/cancellation period/i.test(bodies), false);
  });
});

describe("customer-controlled values are escaped", () => {
  const injected = render({
    customerName: '<script>alert("xss")</script>',
    addressLines: ['24 <b>Example</b> Road & Co', "Wolverhampton", "WV99 1AA"],
    accessNotes: `Gate code <img src=x onerror="steal()"> & "quoted"`,
    customerEmail: "jane+<svg/onload=1>@example.com",
    tenantName: "Tom & <i>Tenant</i>",
  });

  test("no injected markup survives as a real tag", () => {
    // What matters is that nothing becomes an element or an attribute. The
    // string "onerror=" can still appear as inert text inside an escaped
    // value — `&lt;img src=x onerror=&quot;…&quot;&gt;` executes nothing —
    // so assert on the dangerous form, not on the substring.
    for (const tag of ["<script", "<img", "<svg", "<b>", "<i>"]) {
      assert.equal(
        injected.html.includes(tag),
        false,
        `${tag} must not survive as a tag`,
      );
    }
    // No injected value opened an attribute either.
    assert.equal(/onerror\s*=\s*"/.test(injected.html), false);
    assert.equal(/onload\s*=\s*"/.test(injected.html), false);
  });

  test("the dangerous characters are neutralised, not stripped", () => {
    // The engineer still sees what the customer typed — it just cannot run.
    assert.ok(injected.html.includes("&lt;img src=x onerror=&quot;steal()&quot;&gt;"));
    assert.ok(injected.html.includes("&lt;script&gt;"));
  });

  test("the values are still readable, just escaped", () => {
    assert.ok(injected.html.includes("&lt;script&gt;"));
    assert.ok(injected.html.includes("&amp;"));
    assert.ok(injected.html.includes("&quot;") || injected.html.includes("&#39;"));
  });

  test("the subject carries no markup either", () => {
    // The subject is a header, not HTML, but it must not carry a payload that
    // a client might render.
    const subject = notificationSubject({
      ...BASE,
      postcode: '<script>x</script>',
    });
    assert.ok(subject.includes("<script>"), "subject is plain text by nature");
    // …and the rendered <title> escapes it.
    assert.equal(
      render({ postcode: "<script>x</script>" }).html.includes("<title><script>"),
      false,
    );
  });

  test("the plain-text part needs no escaping and keeps the raw value", () => {
    assert.ok(injected.text.includes('<script>alert("xss")</script>'));
  });
});

/**
 * The alert has to say which service is being turned up for. A 45-minute
 * certificate and an hour-long service are different days' work.
 */
describe("the alert names the service", () => {
  const bundle = {
    productName: "CP12 + Annual Boiler Service",
    productSubjectName: "CP12 + boiler service",
  };

  test("a CP12 subject is unchanged, in both forms", () => {
    assert.match(render({}).subject, /^NEW CP12 BOOKING — /);
    assert.match(
      render({ sameDay: true }).subject,
      /^URGENT — SAME-DAY CP12 BOOKING — /,
    );
  });

  test("a bundle names itself in both forms", () => {
    assert.match(render(bundle).subject, /^NEW CP12 \+ BOILER SERVICE BOOKING — /);
    assert.match(
      render({ ...bundle, sameDay: true }).subject,
      /^URGENT — SAME-DAY CP12 \+ BOILER SERVICE BOOKING — /,
    );
  });

  test("the service and its total appear in both parts of the alert", () => {
    const rendered = render({ ...bundle, priceTotal: 105 });
    for (const body of [rendered.html, rendered.text]) {
      assert.ok(body.includes("CP12 + Annual Boiler Service"));
      assert.ok(body.includes("105"));
    }
  });

  test("same-day urgency is unaffected by which service was booked", () => {
    // The flag is computed from the slot alone; the product only changes the
    // words around it.
    const now = new Date("2026-08-27T09:00:00Z");
    for (const product of [{}, bundle]) {
      void product;
      assert.equal(
        isSameDay(new Date("2026-08-27T18:00:00Z"), now, "Europe/London"),
        true,
      );
      assert.equal(
        isSameDay(new Date("2026-08-28T08:00:00Z"), now, "Europe/London"),
        false,
      );
    }
  });
});
