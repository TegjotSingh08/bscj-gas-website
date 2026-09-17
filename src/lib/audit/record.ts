import "server-only";

import { getDb } from "@/lib/db/client";
import { auditEvents } from "@/lib/db/schema";

/**
 * Writing to the security log.
 *
 * `audit_event` is append-only and admin-only: sign-ins, permission changes,
 * impersonation, document access. It is deliberately not the `activity`
 * timeline an agent is shown — merging them would either leak security events
 * into a customer view or hide the timeline.
 *
 * **Never fatal.** An audit write that failed must not roll back the action it
 * was recording: refusing to suspend an agency because a log line would not
 * write is the wrong failure. A missed line is visible as a gap; a refused
 * suspension is an agency still logged in.
 *
 * `detail` carries business context only. Never a credential, never a password
 * or hash, never a document body, never a connection string.
 */

export type AuditEvent = {
  /** Null for an unauthenticated event, such as a failed sign-in. */
  actorUserId?: string | null;
  actorDescription?: string | null;
  /** Set when an administrator was acting as an agency — V2.8. */
  impersonatedUserId?: string | null;
  impersonatedOrganisationId?: string | null;
  /** e.g. "organisation.created", "user.suspended". */
  kind: string;
  subjectType?: string | null;
  subjectId?: string | null;
  detail?: Record<string, unknown> | null;
};

export async function recordAudit(event: AuditEvent): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    await db.insert(auditEvents).values({
      actorUserId: event.actorUserId ?? null,
      actorDescription: event.actorDescription ?? null,
      impersonatedUserId: event.impersonatedUserId ?? null,
      impersonatedOrganisationId: event.impersonatedOrganisationId ?? null,
      kind: event.kind,
      subjectType: event.subjectType ?? null,
      subjectId: event.subjectId ?? null,
      detail: event.detail ?? null,
    });
  } catch {
    // A gap in the log is a smaller problem than a refused action.
  }
}
