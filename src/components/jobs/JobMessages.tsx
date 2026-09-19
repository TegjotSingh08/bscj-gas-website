import { bookingConfig } from "@/lib/booking/config";
import type { JobNotification } from "@/lib/notifications/outbox";

/**
 * Every message this job has queued, and what became of it.
 *
 * The wording is the point. `sent` in the database means **the provider
 * accepted it** — nothing in this system knows whether it arrived, was opened
 * or went to spam — so this never says "delivered", and a queued message is
 * never described as sent.
 *
 * No address appears here, and no token: an invitation's link exists in the
 * message body and nowhere else.
 */
export function JobMessages({
  notifications,
  children,
}: {
  notifications: JobNotification[];
  /** The resend control, when the viewer is allowed one. */
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold text-navy-900">Messages</h2>

      {notifications.length === 0 ? (
        <p className="mt-2 text-sm text-navy-600">Nothing has been queued.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {notifications.map((n) => (
            <li
              key={`${n.kind}-${n.recipient}-${n.createdAt.toISOString()}`}
              className="border-b border-navy-100 pb-2 text-sm last:border-0 last:pb-0"
            >
              <p className="font-semibold text-navy-900">
                {label(n.kind)} → {who(n.recipient)}
              </p>
              <p className={n.state === "failed" ? "text-flame-600" : "text-navy-700"}>
                {describe(n)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {children}
    </section>
  );
}

function label(kind: string): string {
  if (kind === "tenant-scheduling-invitation") return "Invitation to book";
  if (kind === "tenant-appointment-confirmation") return "Appointment confirmation";
  if (kind === "late-booking-exception") return "Late-booking alert";
  return kind;
}

function who(recipient: string): string {
  if (recipient === "tenant") return "tenant";
  if (recipient === "agent") return "agency";
  if (recipient === "bscj") return "BSCJ";
  return recipient;
}

/**
 * Deliberately never says "delivered".
 *
 * A provider accepting a message is the furthest thing this system knows.
 */
function describe(n: JobNotification): string {
  if (n.state === "sent") {
    const when = n.sentAt
      ? n.sentAt.toLocaleString("en-GB", {
          timeZone: bookingConfig.timeZone,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;
    return when
      ? `Accepted by the email provider on ${when}`
      : "Accepted by the email provider";
  }

  if (n.state === "cancelled") {
    return `Stood down — ${reason(n.lastError)}`;
  }

  if (n.state === "failed") {
    return n.lastError?.endsWith("_email_missing")
      ? `Not sent — ${reason(n.lastError)}`
      : `Given up after ${n.attempts} attempts — ${reason(n.lastError)}`;
  }

  if (n.lastError?.endsWith("_email_missing")) {
    return `Cannot be sent — ${reason(n.lastError)}`;
  }

  return n.attempts > 0
    ? `Queued, ${n.attempts} attempt${n.attempts === 1 ? "" : "s"} so far — ${reason(n.lastError)}`
    : "Queued, not yet attempted";
}

/** Plain English for the categories the worker records. */
function reason(code: string | null): string {
  switch (code) {
    case "tenant_email_missing":
      return "no email address on file for the tenant";
    case "agent_email_missing":
      return "no email address on file for the agency";
    case "bscj_email_missing":
      return "BOOKING_NOTIFICATION_EMAIL is not configured";
    case "transport_not_configured":
      return "the email provider is not configured";
    case "superseded_by_appointment_change":
      return "the appointment changed";
    case "job_cancelled":
      return "the job was cancelled";
    case "job_not_schedulable":
      return "the job is finished";
    case "exception_cleared":
      return "the booking now meets the deadline";
    case "timeout":
      return "the provider did not answer in time";
    case "rate_limited":
      return "the provider is rate limiting us";
    case "unauthorised":
      return "the provider rejected our credentials";
    case null:
      return "retrying";
    default:
      return code;
  }
}
