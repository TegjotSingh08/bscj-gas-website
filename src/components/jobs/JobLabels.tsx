import type { JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import {
  ATTENTION_LABELS,
  type AttentionReason,
} from "@/lib/jobs/attention";
import type { DeadlineRisk } from "@/lib/compliance/renewal";

/**
 * The small pieces of vocabulary the operations screens share.
 *
 * One module, because a status that reads "engineer assigned" on one screen
 * and "Allocated" on another is two vocabularies for one fact — and the
 * person holding the phone is the same person who read the other screen an
 * hour ago.
 *
 * Presentational only. Nothing here touches the database, the session or the
 * price list, which is what keeps it usable from the restricted engineer
 * surface as well as from the admin area.
 */

/** What each lifecycle status is called in front of a person. */
export const STATUS_LABELS: Readonly<Record<JobLifecycleStatus, string>> = {
  draft: "Draft",
  tenant_outreach: "Inviting tenant",
  awaiting_tenant: "With the tenant",
  scheduled: "Scheduled",
  engineer_assigned: "Allocated",
  in_progress: "On site",
  remedial_required: "Remedial needed",
  completed: "Done",
  cancelled: "Cancelled",
};

/**
 * The colour each status carries.
 *
 * Three tones and no more. Green is "finished as intended", amber is "needs
 * somebody", navy is "proceeding normally" — and cancelled is deliberately
 * quiet rather than red, because a cancelled job is not a failure.
 */
const STATUS_TONE: Readonly<Record<JobLifecycleStatus, string>> = {
  draft: "bg-navy-100 text-navy-700",
  tenant_outreach: "bg-navy-100 text-navy-700",
  awaiting_tenant: "bg-navy-100 text-navy-700",
  scheduled: "bg-navy-100 text-navy-800",
  engineer_assigned: "bg-flame-400/20 text-navy-900",
  in_progress: "bg-flame-500/25 text-navy-900",
  remedial_required: "bg-flame-500/25 text-navy-900",
  completed: "bg-trust-50 text-trust-600",
  cancelled: "bg-navy-100 text-navy-600",
};

export function StatusPill({ status }: { status: JobLifecycleStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_TONE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Who commissioned the work, said plainly.
 *
 * The distinction BSCJ runs on, so it is on every row rather than inferable
 * from a blank column. "Private" is a homeowner who booked on the website;
 * anything else names the agency.
 */
export function ClientPill({
  organisationName,
}: {
  organisationName: string | null;
}) {
  if (!organisationName) {
    return (
      <span className="inline-block whitespace-nowrap rounded-full bg-trust-50 px-2.5 py-1 text-xs font-bold text-trust-600">
        Private
      </span>
    );
  }
  return (
    <span
      className="inline-block max-w-[12rem] truncate rounded-full bg-navy-100 px-2.5 py-1 text-xs font-bold text-navy-800"
      title={organisationName}
    >
      {organisationName}
    </span>
  );
}

/** Every reason a job is on the needs-attention list, as small chips. */
export function AttentionChips({
  reasons,
}: {
  reasons: readonly AttentionReason[];
}) {
  if (reasons.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {reasons.map((reason) => (
        <span
          key={reason}
          className="inline-block whitespace-nowrap rounded-full border border-flame-500 bg-flame-400/10 px-2 py-0.5 text-[0.7rem] font-bold text-navy-900"
        >
          {ATTENTION_LABELS[reason]}
        </span>
      ))}
    </span>
  );
}

const RISK_LABELS: Readonly<Record<DeadlineRisk, string>> = {
  normal: "In good time",
  approaching: "Approaching",
  urgent: "Due this week",
  overdue: "Overdue",
};

/**
 * How close the customer's requested date is.
 *
 * Only shown when it is worth showing. A job comfortably inside its deadline
 * needs no badge, and one on every row is one nobody reads.
 */
export function DeadlineNote({
  risk,
  completeByDate,
}: {
  risk: DeadlineRisk | null;
  completeByDate: string | null;
}) {
  if (!risk || !completeByDate) return null;
  if (risk === "normal") return null;

  const tone =
    risk === "overdue"
      ? "text-flame-600"
      : risk === "urgent"
        ? "text-flame-600"
        : "text-navy-600";

  return (
    <span className={`whitespace-nowrap text-xs font-bold ${tone}`}>
      {RISK_LABELS[risk]} · by {completeByDate}
    </span>
  );
}
