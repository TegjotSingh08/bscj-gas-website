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
  | "network";

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

/** Logs a failure category only — never the key, the payload or the customer. */
function reportFailure(reason: EmailFailureReason, reference: string): void {
  console.warn(
    `[booking-email] send failed (${reason}) for reference ${reference}`,
  );
}

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
        // Resend de-duplicates on this, so a retry of the same booking cannot
        // produce a second email even if our first attempt timed out after
        // the provider had already accepted it.
        "Idempotency-Key": `booking-confirmation-${reference}`,
      },
      body: JSON.stringify({
        from: credentials.from,
        to: [to],
        reply_to: replyTo(),
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      reportFailure("unauthorised", reference);
      return { status: "failed", reason: "unauthorised" };
    }
    if (response.status === 429) {
      reportFailure("rate_limited", reference);
      return { status: "failed", reason: "rate_limited" };
    }
    if (!response.ok) {
      reportFailure("rejected", reference);
      return { status: "failed", reason: "rejected" };
    }

    try {
      const data = (await response.json()) as { id?: string };
      return { status: "sent", id: data.id ?? null };
    } catch {
      // Accepted but unreadable. The message is very likely on its way, so
      // this is reported as a failure only for the customer-facing warning —
      // it never affects the booking.
      reportFailure("malformed_response", reference);
      return { status: "failed", reason: "malformed_response" };
    }
  } catch (error) {
    const reason: EmailFailureReason =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "network";
    reportFailure(reason, reference);
    return { status: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}
