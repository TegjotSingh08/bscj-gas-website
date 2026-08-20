import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { emailNotice } from "./confirmation-notice";

/**
 * The two states must stay semantically distinct. Telling a customer to check
 * their Junk folder for an email that was never sent is worse than saying
 * nothing, and implying an email failed when it succeeded loses the
 * appointment time and booking reference we just gave them.
 */

const SENT = { emailSent: true, customerEmail: "jane@example.com" };
const FAILED = { emailSent: false, customerEmail: "jane@example.com" };

describe("when the email was sent", () => {
  const notice = emailNotice(SENT);

  test("the notice is the sent variant", () => {
    assert.equal(notice.kind, "sent");
  });

  test("it is headed as a confirmation email", () => {
    assert.equal(notice.kind === "sent" && notice.heading, "Confirmation email sent");
  });

  test("it shows the customer's own address, not a hard-coded one", () => {
    assert.equal(notice.kind === "sent" && notice.email, "jane@example.com");
    const other = emailNotice({
      emailSent: true,
      customerEmail: "someone.else@bigcorp.co.uk",
    });
    assert.equal(other.kind === "sent" && other.email, "someone.else@bigcorp.co.uk");
  });

  test("it gives the Junk or Spam guidance", () => {
    assert.equal(
      notice.kind === "sent" && notice.spamAdvice,
      "Can't see it? Check your Junk or Spam folder.",
    );
  });

  test("it tells the customer to keep the email, and why", () => {
    assert.ok(notice.kind === "sent" && notice.keepAdvice.includes("Keep the email"));
    assert.ok(notice.kind === "sent" && notice.keepAdvice.includes("booking reference"));
    assert.ok(notice.kind === "sent" && notice.keepAdvice.includes("appointment time"));
  });

  test("it says sent, never delivered — we have no delivery tracking", () => {
    const wording = JSON.stringify(notice).toLowerCase();
    assert.ok(wording.includes("sent"));
    assert.ok(!wording.includes("delivered"));
    assert.ok(!wording.includes("in your inbox"));
    assert.ok(!wording.includes("arrived"));
  });

  test("it never suggests the booking itself is in doubt", () => {
    const wording = JSON.stringify(notice).toLowerCase();
    assert.ok(!wording.includes("could not"));
    assert.ok(!wording.includes("failed"));
    assert.ok(!wording.includes("problem"));
  });
});

describe("when the email failed", () => {
  const notice = emailNotice(FAILED);

  test("the notice is the failed variant", () => {
    assert.equal(notice.kind, "failed");
  });

  test("it never claims an email was sent", () => {
    const wording = JSON.stringify(notice).toLowerCase();
    assert.ok(!wording.includes("we've sent"));
    assert.ok(!wording.includes("we have sent"));
    assert.ok(!wording.includes("confirmation email sent"));
  });

  test("it gives no Junk or Spam advice, because there is nothing to find", () => {
    const wording = JSON.stringify(notice).toLowerCase();
    assert.ok(!wording.includes("junk"));
    assert.ok(!wording.includes("spam"));
  });

  test("it states plainly that the appointment is confirmed", () => {
    assert.ok(notice.kind === "failed" && notice.heading.includes("confirmed"));
  });

  test("it reassures that nothing is wrong with the appointment", () => {
    assert.ok(
      notice.kind === "failed" &&
        notice.body.includes("Nothing is wrong with your appointment"),
    );
  });

  test("it points the customer at the booking reference", () => {
    assert.ok(notice.kind === "failed" && notice.body.includes("booking reference"));
  });

  test("it carries no customer email address at all", () => {
    assert.ok(!JSON.stringify(notice).includes("jane@example.com"));
  });
});

describe("the two states never overlap", () => {
  test("only one of them ever mentions Junk or Spam", () => {
    const sent = JSON.stringify(emailNotice(SENT)).toLowerCase();
    const failed = JSON.stringify(emailNotice(FAILED)).toLowerCase();
    assert.ok(sent.includes("junk") && sent.includes("spam"));
    assert.ok(!failed.includes("junk") && !failed.includes("spam"));
  });

  test("the kind follows emailSent exactly", () => {
    assert.equal(emailNotice({ emailSent: true, customerEmail: "a@b.co" }).kind, "sent");
    assert.equal(emailNotice({ emailSent: false, customerEmail: "a@b.co" }).kind, "failed");
  });
});

describe("customer-supplied addresses are handled as data", () => {
  test("the address is passed through untouched, for React to escape", () => {
    // The notice never builds markup, so there is no place for an address to
    // become HTML. React escapes it at render time.
    const notice = emailNotice({
      emailSent: true,
      customerEmail: '<script>alert("x")</script>@example.com',
    });
    assert.equal(
      notice.kind === "sent" && notice.email,
      '<script>alert("x")</script>@example.com',
    );
    assert.ok(!JSON.stringify(notice).includes("&lt;"));
  });

  test("a very long address is not truncated or altered", () => {
    const long =
      "a.very.long.customer.email.address.for.testing@an-extremely-long-domain-name.co.uk";
    const notice = emailNotice({ emailSent: true, customerEmail: long });
    assert.equal(notice.kind === "sent" && notice.email, long);
  });
});
