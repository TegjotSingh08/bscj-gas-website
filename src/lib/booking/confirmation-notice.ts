/**
 * What the confirmation screen tells the customer about their email.
 *
 * Kept as data rather than inline JSX so the wording is in one place and can
 * be tested directly — the distinction between "we sent it, check your Junk
 * folder" and "we could not send it" is the part that must never blur.
 *
 * Deliberately says "sent", never "delivered": the application knows the
 * provider accepted the message, not that it reached an inbox.
 */

export type EmailNotice =
  | {
      kind: "sent";
      heading: string;
      intro: string;
      email: string;
      spamAdvice: string;
      keepAdvice: string;
    }
  | {
      kind: "failed";
      heading: string;
      body: string;
    };

export function emailNotice(booking: {
  emailSent: boolean;
  customerEmail: string;
}): EmailNotice {
  if (!booking.emailSent) {
    return {
      kind: "failed",
      heading:
        "Your appointment is confirmed, but we could not send the confirmation email.",
      // No Junk/Spam advice here: nothing was sent, so telling someone to go
      // looking for it would send them on a wild goose chase.
      body: "Please save the details below, or get in touch and quote your booking reference. Nothing is wrong with your appointment.",
    };
  }

  return {
    kind: "sent",
    heading: "Confirmation email sent",
    intro: "We've sent your booking details to:",
    email: booking.customerEmail,
    spamAdvice: "Can't see it? Check your Junk or Spam folder.",
    keepAdvice:
      "Keep the email handy — it contains your appointment time and booking reference.",
  };
}
