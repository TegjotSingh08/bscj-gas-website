import type { TimelineEntry } from "@/lib/jobs/queries";

/**
 * What has happened to a job.
 *
 * The answer to "why is this job like this", which until now could only be
 * got by reading the `activity` table by hand. A status with no account of
 * how it got there is a status somebody works around.
 *
 * Two rules:
 *
 * - **Unknown kinds are shown, not hidden.** A timeline that silently drops
 *   what it does not recognise is a timeline with gaps nobody can see. An
 *   unrecognised kind is printed as it is stored, which is ugly and honest.
 * - **The detail is never rendered raw.** `detail` is structured context and
 *   may carry an internal id; only the few fields that mean something to a
 *   reader are picked out.
 */

/** What each recorded kind is called in front of a person. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  "job.created": "Job recorded",
  "job.note": "Note added",
  "job.engineer_assigned": "Engineer allocated",
  "job.engineer_unassigned": "Engineer taken off",
  "job.started": "Engineer on site",
  "job.completed": "Work recorded as done",
  "appointment.scheduled": "Appointment booked",
  "appointment.rescheduled": "Appointment moved",
  "appointment.deadline_exception": "Booked after the requested date",
  "invitation.resent": "Tenant sent their link again",
  "compliance.recorded": "Compliance record updated",
};

/** Who did it, from the stored actor string. */
function actorLabel(actor: string, actorName: string | null): string {
  if (actor === "system") return "Automatically";
  if (actor === "tenant") return "The tenant";
  if (actor === "customer") return "The customer";
  if (actor.startsWith("user:")) return actorName ?? "A member of staff";
  return actor;
}

/**
 * The one or two fields from `detail` worth showing.
 *
 * Deliberately a short allow-list rather than a dump of the object: the
 * detail is context for an engineer reading the code, and it can contain
 * internal ids that mean nothing on screen and should not be on one.
 */
function detailLine(entry: TimelineEntry, timeZone: string): string | null {
  const detail = entry.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;

  const at = (value: unknown) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value))
      ? new Date(value).toLocaleString("en-GB", {
          timeZone,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;

  if (entry.kind === "appointment.scheduled" || entry.kind === "appointment.rescheduled") {
    const start = at(d.start);
    const previous = at(d.previousStart);
    if (start && previous) return `Moved from ${previous} to ${start}`;
    if (start) return start;
  }

  if (entry.kind === "job.completed" && d.noteRecorded === true) {
    return "An account of the visit was recorded on the job.";
  }

  if (typeof d.note === "string" && d.note.trim() !== "") return d.note;

  return null;
}

export function JobTimeline({
  entries,
  timeZone,
}: {
  entries: TimelineEntry[];
  timeZone: string;
}) {
  return (
    <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold text-navy-900">History</h2>

      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-navy-700">
          Nothing has been recorded against this job yet.
        </p>
      ) : (
        <ol className="mt-3 grid gap-3">
          {entries.map((entry) => {
            const line = detailLine(entry, timeZone);
            return (
              <li
                key={entry.id}
                className="border-l-4 border-navy-100 pl-3 text-sm"
              >
                <p className="font-bold text-navy-900">
                  {KIND_LABELS[entry.kind] ?? entry.kind}
                </p>
                <p className="text-xs text-navy-600">
                  {entry.createdAt.toLocaleString("en-GB", {
                    timeZone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}{" "}
                  · {actorLabel(entry.actor, entry.actorName)}
                </p>
                {line && <p className="mt-0.5 text-navy-800">{line}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
