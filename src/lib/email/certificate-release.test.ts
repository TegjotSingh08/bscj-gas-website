import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderCertificateReleaseEmail } from "./certificate-release";

/**
 * The released-certificate email.
 *
 * This file exists because of one fault. The message was written in V2.6,
 * when nothing was attached, and it told the recipient so. V2.7 started
 * attaching the released PDF (§20.b) and the wording was not revisited — so
 * every certificate went out with its document attached and a line underneath
 * saying it was not.
 *
 * Nothing caught it, because nothing asserted on what the message claimed.
 * These tests do, in both the HTML and the plain-text part, which are built
 * from the same strings and must therefore never disagree.
 *
 * All facts below are fictional.
 */

const FACTS = {
  reference: "BSCJ-IN0001",
  certificateNumber: "FIXTURE-0001",
  address: "14 Example Road",
  postcode: "WV3 3CC",
  inspectionDate: "2026-09-17",
  nextDueDate: "2027-09-16",
  correctionReason: null,
  version: 1,
  portalLink: "https://example.invalid/portal/jobs/fixture",
  timeZone: "Europe/London",
};

describe("the certificate release email describes what is actually sent", () => {
  test("it says the record is attached, because it is", () => {
    const email = renderCertificateReleaseEmail(FACTS);
    assert.match(email.html, /attached to this email as a PDF/);
    assert.match(email.text, /attached to this email as a PDF/);
  });

  test("it never says the document is not attached", () => {
    const email = renderCertificateReleaseEmail(FACTS);
    for (const part of [email.html, email.text, email.subject, email.preheader]) {
      assert.equal(
        /not attached/i.test(part),
        false,
        "the message contradicts its own attachment",
      );
    }
  });

  test("the HTML and the plain text make the same claim", () => {
    // They are built from one list of strings. If they ever diverge, one of
    // them is describing a message that was not sent.
    const email = renderCertificateReleaseEmail(FACTS);
    assert.equal(/attached/i.test(email.html), /attached/i.test(email.text));
  });

  test("a correction still says why, and still says it is attached", () => {
    const email = renderCertificateReleaseEmail({
      ...FACTS,
      version: 2,
      correctionReason: "The appliance count was wrong.",
    });
    assert.match(email.subject, /Corrected/);
    assert.match(email.html, /The appliance count was wrong\./);
    assert.match(email.html, /attached to this email as a PDF/);
  });

  test("no price appears — a certificate is not a bill", () => {
    const email = renderCertificateReleaseEmail(FACTS);
    for (const part of [email.html, email.text, email.subject]) {
      assert.equal(/£|pence|invoice|amount due/i.test(part), false);
    }
  });
});
