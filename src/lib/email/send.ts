import "server-only";

import { business } from "@/lib/business";
import type { RenderedEmail } from "./booking-confirmation";

/**
 * Transactional email transport (Resend).
 *
 * Deliberately a small fetch wrapper rather than the SDK: Resend authenticates
 * with a single bearer header, so there is no provider authentication being
 * "recreated", and the SDK's dependencies (inbound MIME parsing, webhook
 * signature verification) are for features this project does not use.
 *
 * The one hard rule: **this module never throws**. A confirmed appointment
 * must never be undone because an email failed, so every failure is returned
 * as a value for the caller to record and move on.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Long enough for a normal send, short enough not to stall the booking response. */
const TIMEOUT_MS = 8000;

export type EmailResult =
  | { status: "sent"; id: string | null }
  | { status: "not_configured" }
  | { status: "failed"; reason: EmailFailureReason };

/**
 * Coarse failure categories. Deliberately not the provider's message: that can
 * carry request detail, and nothing here is shown to a customer anyway.
 */
export type EmailFailureReason =
  | "timeout"
  | "rejected"
  | "unauthorised"
  | "rate_limited"
  | "malformed_response"
  | "network"
  /**
   * The provider has seen this idempotency key with **different content**.
   *
   * Resend keeps a key for 24 hours and refuses to reuse it on a changed
   * payload. Retrying changes nothing — the key or the content has to move —
   * so this is terminal by nature and must not be spent on four more
   * identical attempts.
   */
  | "idempotency_conflict"
  /**
   * Another request with this key is still in flight at the provider.
   *
   * Transient and, importantly, **not evidence that anything failed**: the
   * request already running may be about to succeed. Worth another attempt
   * later; not worth alarming anybody about.
   */
  | "in_flight";

type Credentials = { apiKey: string; from: string };

function readCredentials(): Credentials | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_EMAIL_FROM;
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function isEmailConfigured(): boolean {
  return readCredentials() !== null;
}

/**
 * Where customer replies should land. Falls back to the booking inbox already
 * recorded in the business details rather than inventing an address.
 */
function replyTo(): string {
  return process.env.BOOKING_EMAIL_REPLY_TO || business.emailBooking;
}

/**
 * Logs a failure category and the booking reference only — never the key, the
 * payload, the recipient or anything else about the customer. The reference is
 * an opaque label that grants nothing, so it is safe to put in a log and is
 * enough to find the booking.
 */
function reportFailure(
  kind: EmailKind,
  reason: EmailFailureReason,
  reference: string,
): void {
  console.warn(`[${kind}] send failed (${reason}) for reference ${reference}`);
}

/**
 * The provider's own name for an error, when it gives one.
 *
 * Only the `name` field is read, and only against a closed set of values we
 * act on. The message text can carry request detail and never reaches a screen.
 */
async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body?.name === "string" ? body.name : null;
  } catch {
    return null;
  }
}

/** Which email a send belongs to, for logs and provider idempotency keys. */
type EmailKind =
  | "booking-confirmation"
  | "booking-notification"
  | "tenant-invitation"
  | "tenant-appointment"
  | "late-booking-agent"
  | "late-booking-internal"
  | "certificate-release"
  | "invoice-issue"
  | "account-invitation"
  | "account-password-reset";

/**
 * The one place an email is actually sent.
 *
 * Both callers share it so the timeout, the failure categories and the
 * never-throw guarantee cannot drift apart between them.
 */
export type EmailAttachment = {
  /** What the recipient sees it saved as. Already sanitised by the caller. */
  filename: string;
  /** The bytes. Base64-encoded here, once, at the point of sending. */
  content: Uint8Array;
};

/**
 * The largest attachment this will send.
 *
 * Resend's own limit is on the whole encoded request. Base64 inflates by a
 * third, so the bytes have to leave room for that plus the message body —
 * 15 MB of PDF is comfortably inside it and far above the ~500 KB a
 * certificate actually is. A file over this is a fault worth reporting, not
 * something to try and then have the provider refuse.
 */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

async function deliver({
  kind,
  to,
  email,
  reference,
  replyToAddress,
  attachments,
}: {
  kind: EmailKind;
  to: string;
  email: RenderedEmail;
  reference: string;
  replyToAddress: string;
  attachments?: EmailAttachment[];
}): Promise<EmailResult> {
  const credentials = readCredentials();
  if (!credentials) return { status: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
        /*
          **What this actually buys, precisely.**

          Resend keeps an idempotency key for **24 hours**. Within that window,
          the same key with the *same* payload returns the original response
          without sending again — which is what makes a retry after a timeout
          safe. The same key with a *different* payload is refused (409), and
          after 24 hours the key is forgotten, so a retry then can produce a
          second copy.

          So this is "not twice within a day, for a message whose content has
          not changed" — not exactly-once delivery, and it is never described
          as such. Callers whose content changes per attempt must vary the key
          with the content; see the credential emails in `notifications/outbox`.
        */
        "Idempotency-Key": `${kind}-${reference}`,
      },
      body: JSON.stringify({
        from: credentials.from,
        to: [to],
        reply_to: replyToAddress,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(attachments && attachments.length
          ? {
              attachments: attachments.map((file) => ({
                filename: file.filename,
                content: Buffer.from(file.content).toString("base64"),
              })),
            }
          : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      reportFailure(kind, "unauthorised", reference);
      return { status: "failed", reason: "unauthorised" };
    }
    if (response.status === 429) {
      reportFailure(kind, "rate_limited", reference);
      return { status: "failed", reason: "rate_limited" };
    }

    /*
      Resend answers 409 for two different things, and treating them alike is
      how a message either spins for four more attempts against a wall or gets
      reported as broken when it was merely still going out.
    */
    if (response.status === 409) {
      const name = await errorName(response);
      const reason: EmailFailureReason =
        name === "concurrent_idempotent_requests" ? "in_flight" : "idempotency_conflict";
      reportFailure(kind, reason, reference);
      return { status: "failed", reason };
    }

    if (!response.ok) {
      reportFailure(kind, "rejected", reference);
      return { status: "failed", reason: "rejected" };
    }

    try {
      const data = (await response.json()) as { id?: string };
      return { status: "sent", id: data.id ?? null };
    } catch {
      // Accepted but unreadable. The message is very likely on its way, so
      // this is reported as a failure only for the customer-facing warning —
      // it never affects the booking.
      reportFailure(kind, "malformed_response", reference);
      return { status: "failed", reason: "malformed_response" };
    }
  } catch (error) {
    const reason: EmailFailureReason =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "network";
    reportFailure(kind, reason, reference);
    return { status: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The customer's booking confirmation.
 *
 * Replies go to the booking inbox, because the customer is the recipient.
 */
export async function sendBookingConfirmation({
  to,
  email,
  /** Used as the provider idempotency key and in failure logs. */
  reference,
}: {
  to: string;
  email: RenderedEmail;
  reference: string;
}): Promise<EmailResult> {
  return deliver({
    kind: "booking-confirmation",
    to,
    email,
    reference,
    replyToAddress: replyTo(),
  });
}

/**
 * Where the internal alert goes. Server-side only, and deliberately its own
 * variable rather than reusing the booking inbox — the operational alert and
 * the address customers reply to are different jobs and may want different
 * destinations.
 *
 * Unset means no internal notification is attempted. That is a deployment
 * gap, not a booking failure, so it is reported as `not_configured` exactly
 * like a missing API key.
 */
function notificationRecipient(): string | null {
  return process.env.BOOKING_NOTIFICATION_EMAIL || null;
}

export function isBookingNotificationConfigured(): boolean {
  return isEmailConfigured() && notificationRecipient() !== null;
}

/**
 * The internal alert to BSCJ that a booking has been made.
 *
 * Never throws, exactly like the customer email: by the time this runs the
 * calendar event already exists, and nothing here may undo it.
 *
 * `replyToAddress` is the customer's own address, so replying to the alert
 * reaches them directly. That is the whole point of an operational email.
 */
export async function sendBookingNotification({
  email,
  reference,
  customerEmail,
}: {
  email: RenderedEmail;
  reference: string;
  customerEmail: string;
}): Promise<EmailResult> {
  const to = notificationRecipient();
  if (!to) return { status: "not_configured" };

  return deliver({
    kind: "booking-notification",
    to,
    email,
    reference,
    replyToAddress: customerEmail,
  });
}

/**
 * A send driven by the durable outbox.
 *
 * The same transport, the same timeout, the same never-throw guarantee — the
 * only difference is that the caller already has a row recording the intent,
 * so it decides what the outcome means rather than this module.
 *
 * `idempotencySuffix` becomes part of the provider idempotency key, so two
 * recipients of the same event cannot collapse into one message while a retry
 * of either still cannot produce a second.
 *
 * **`sent` means the provider accepted it.** It is not a delivery receipt and
 * must never be reported as one.
 */
export async function sendOutboxEmail({
  kind,
  to,
  email,
  reference,
  idempotencySuffix,
  replyToAddress,
  attachments,
}: {
  kind:
    | "tenant-invitation"
    | "tenant-appointment"
    | "late-booking-agent"
    | "late-booking-internal"
    | "certificate-release"
    | "invoice-issue"
    | "account-invitation"
    | "account-password-reset";
  to: string;
  email: RenderedEmail;
  reference: string;
  idempotencySuffix: string;
  replyToAddress?: string;
  attachments?: EmailAttachment[];
}): Promise<EmailResult> {
  /*
    `reference` plus the suffix becomes the provider's idempotency key, and
    it is **stable across retries on purpose**: a second attempt after a
    timeout must be recognised by Resend as the same message rather than
    sent again. The one caller that deliberately varies it is the tenant
    invitation, which mints a new link per attempt and is therefore a
    genuinely different message.
  */
  return deliver({
    kind,
    to,
    email,
    reference: `${reference}-${idempotencySuffix}`,
    replyToAddress: replyToAddress ?? replyTo(),
    attachments,
  });
}

/** The internal alert address, for callers that must report it as missing. */
export function internalNotificationRecipient(): string | null {
  return notificationRecipient();
}
