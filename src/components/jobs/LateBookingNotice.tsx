import { formatLongDate } from "@/lib/booking/time";
import { bookingConfig } from "@/lib/booking/config";
import type { RecordedException } from "@/lib/notifications/outbox";

/**
 * "This was booked after the deadline."
 *
 * Shown to BSCJ and to the agency, with the same facts. Three things it must
 * never do: imply the deadline was met, imply it has moved, or imply the
 * certificate now runs later. It states the date that was asked for, the date
 * the certificate expires, which of the two produced the cutoff, and that the
 * tenant was warned and accepted.
 *
 * A notification's `sent` state means **the provider accepted it** — not that
 * anybody received it — and the wording here says so.
 */
export function LateBookingNotice({
  exception,
  notifications,
  audience,
}: {
  exception: RecordedException;
  notifications: {
    recipient: string;
    state: string;
    attempts: number;
    lastError: string | null;
  }[];
  audience: "admin" | "agent";
}) {
  const tz = bookingConfig.timeZone;

  return (
    <section className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-5">
      <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
        Needs attention
      </p>
      <h2 className="mt-1 text-sm font-extrabold text-navy-900">
        Booked after the deadline
      </h2>

      <dl className="mt-3 grid gap-2 text-sm">
        <Fact label="Deadline" value={formatLongDate(exception.deadlineDate, tz)} />
        <Fact
          label="Requested completion date"
          value={
            exception.requestedBy
              ? formatLongDate(exception.requestedBy, tz)
              : "not given"
          }
        />
        <Fact
          label="Certificate due"
          value={
            exception.certificateDueBy
              ? formatLongDate(exception.certificateDueBy, tz)
              : "not given"
          }
        />
        <Fact
          label="Cutoff taken from"
          value={sourceLabel(exception.deadlineSource)}
        />
        <Fact
          label="Tenant acknowledged"
          value={exception.acknowledgedAt.toLocaleString("en-GB", {
            timeZone: tz,
            dateStyle: "full",
            timeStyle: "short",
          })}
        />
      </dl>

      <p className="mt-3 border-t-2 border-flame-500/30 pt-3 text-sm leading-relaxed text-navy-800">
        The deadline has not changed and no certificate expiry has been
        extended. The tenant was shown this and chose the time anyway.
      </p>

      {audience === "admin" && notifications.length > 0 && (
        <div className="mt-3 border-t-2 border-flame-500/30 pt-3">
          <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
            Notifications
          </p>
          <ul className="mt-1 grid gap-1 text-sm text-navy-800">
            {notifications.map((n) => (
              <li key={`${n.recipient}-${n.state}-${n.attempts}`}>
                <span className="font-semibold">
                  {n.recipient === "agent" ? "Agency" : "BSCJ"}:
                </span>{" "}
                {describe(n)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="sm:grid sm:grid-cols-3 sm:gap-3">
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 font-semibold text-navy-900 sm:col-span-2 sm:mt-0">
        {value}
      </dd>
    </div>
  );
}

function sourceLabel(source: RecordedException["deadlineSource"]): string {
  if (source === "both") return "both dates, which fall on the same day";
  if (source === "requested") return "the requested completion date";
  return "the certificate expiry";
}

/**
 * Deliberately never says "delivered".
 *
 * A provider accepting a message is the furthest thing this system knows.
 */
function describe(n: {
  state: string;
  attempts: number;
  lastError: string | null;
}): string {
  if (n.state === "sent") return "accepted by the email provider";
  if (n.state === "cancelled") {
    return `stood down (${n.lastError ?? "superseded"})`;
  }
  if (n.state === "failed") {
    return n.lastError?.endsWith("_email_missing")
      ? "not sent — no address is configured for this recipient"
      : `not sent after ${n.attempts} attempts (${n.lastError ?? "unknown"})`;
  }
  return n.attempts > 0
    ? `queued, ${n.attempts} attempt(s) so far (${n.lastError ?? "retrying"})`
    : "queued, not yet attempted";
}
