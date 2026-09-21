import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { portfolioImports } from "@/lib/db/schema";
import {
  createProperty,
  replaceTenancy,
  setCompliancePosition,
  updateLandlord,
} from "../mutations";
import { lookupExistingByPostcode, type ExistingProperty } from "./lookup";
import { fingerprintOf } from "./plan";
import type { ImportEnvelope, PlannedWrite } from "./envelope";
import type { LandlordChoice, Resolution } from "./plan";

/**
 * Writing a reviewed plan.
 *
 * Three properties matter, and each cost a design decision:
 *
 * **1. It writes only what the agent reviewed.** Every record comes out of the
 * signed envelope, which is what they saw on screen. Nothing is re-parsed from
 * a file, because there is no file any more.
 *
 * **2. It is retry-safe, and by the database rather than by hope.** The import
 * is *claimed* with an insert that a unique index on
 * `(agent_organisation_id, plan_digest)` arbitrates. Two browsers pressing
 * Confirm produce one winner and one "this has already been submitted"; a
 * refresh after a successful import shows the result rather than importing
 * again. A read-then-write would lose both races.
 *
 * **3. A partial failure is reported as a partial failure.** Rows are written
 * one at a time, on purpose. Wrapping 200 properties in one transaction sounds
 * tidier and is worse: one bad postcode would discard 199 good properties, and
 * the agent would have to find it in a spreadsheet with no indication of which
 * row it was. Each row succeeds or fails on its own, every outcome is recorded
 * against its line number, and the agent is told exactly what happened.
 *
 * **Nothing here creates a job, sends an email or touches the calendar.**
 * Importing a portfolio is a record-keeping act. A file of 200 properties that
 * quietly raised 200 jobs would book out the diary for a month and email 200
 * tenants about visits nobody arranged. Work is requested afterwards,
 * deliberately, property by property.
 */

export type RowOutcome =
  | { line: number; outcome: "created"; propertyId: string }
  | { line: number; outcome: "updated" }
  | { line: number; outcome: "skipped"; reason: string }
  | { line: number; outcome: "failed"; reason: string };

export type CommitResult =
  | {
      status: "done" | "partial" | "failed";
      importId: string;
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      rows: RowOutcome[];
    }
  /** Already submitted. Carries what that submission did, so the agent sees it. */
  | { status: "already_submitted"; importId: string; previous: StoredResult | null }
  | { status: "not_configured" }
  | { status: "failed_to_claim" };

export type StoredResult = {
  status: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  rows: RowOutcome[];
};

/**
 * Applies one reviewed row.
 *
 * A `create` that turns out to be a duplicate — because somebody else imported
 * the same address in the seconds since the preview was built — is reported as
 * *skipped*, not failed. It is the ordinary outcome of two people working at
 * once, and the property exists, which is what the agent wanted.
 */
async function applyRow(
  organisationId: string,
  actorUserId: string,
  write: PlannedWrite,
  resolution: Resolution,
  /** Who the agent said this row's contactless landlord is. */
  identity: LandlordChoice,
  /** The portfolio as it is **now**, not as the preview saw it. */
  current: Map<string, ExistingProperty>,
): Promise<RowOutcome> {
  const { record } = write;

  if (write.action === "conflict") {
    /*
      The default, and it is `skip`. A resolution the form did not carry — a
      lost checkbox, a truncated submission, a field somebody removed — must
      never be read as permission to overwrite a tenant or a certificate date.
    */
    if (resolution !== "update") {
      return {
        line: write.line,
        outcome: "skipped",
        reason: "Left as it is — no change requested.",
      };
    }

    /*
      Some differences are reported and never applied — a different landlord,
      a different street. The preview said so and the envelope carries it under
      the signature, so a submission claiming otherwise is refused here rather
      than re-deciding the rule a second time and possibly differently.
    */
    if (write.applicable !== true) {
      return {
        line: write.line,
        outcome: "skipped",
        reason: "This difference needs changing on the property itself.",
      };
    }

    const propertyId = write.existingPropertyId;
    if (!propertyId) {
      return { line: write.line, outcome: "failed", reason: "Property not found." };
    }

    /*
      **The approval is for the record the agent actually saw.**

      A preview is a snapshot, and minutes or hours pass before Confirm. If a
      colleague changed the tenant or the certificate date in between, applying
      the approval anyway would end a tenancy the agent never saw and never
      agreed to end — which is exactly what it did before this check existed.

      So the state the conflicts were judged against is re-read now and
      compared with the fingerprint carried under the envelope's signature.
      Any movement and the row is left completely alone, with a message that
      says what happened and what to do. Skipped, not failed: nothing went
      wrong, the world simply moved.
    */
    const now = current.get(record.key);
    if (!now || !write.observed || fingerprintOf(now) !== write.observed) {
      return {
        line: write.line,
        outcome: "skipped",
        reason:
          "This property changed after you reviewed it, so nothing was altered. Import it again to see the current record.",
      };
    }

    let touched = false;

    /*
      The landlord's own details.

      **Only the landlord this property already belongs to, and only when the
      file names them by the same email.** An email identifies a person; a name
      does not, and a property's current owner is not evidence that the row is
      about them. So the update goes to `now.landlordId` — the owner as freshly
      read, already proven unmoved by the fingerprint check above — and only
      when the file's email matches theirs.

      That is precisely the condition under which the preview marks "Landlord
      details" applicable, so the promise and the write now say the same thing.
      Two earlier shapes are gone with it: looking the email up across the
      agency could edit a *different* landlord who happened to hold it, and a
      row with no email at all was offered as applicable and then silently did
      nothing.
    */
    const fileEmail = (record.landlord.email ?? "").trim();
    const heldEmail = (now.landlordEmail ?? "").trim();
    const identifiesTheOwner =
      fileEmail !== "" &&
      heldEmail !== "" &&
      fileEmail.toLowerCase() === heldEmail.toLowerCase();

    if (identifiesTheOwner) {
      const updated = await updateLandlord(
        organisationId,
        now.landlordId,
        record.landlord,
        actorUserId,
      );
      if (updated.status === "ok") touched = true;
    }

    /*
      Each part is applied through the mutation that already owns its rule, so
      an import cannot do something the manual screens would not:

      - a tenancy is *replaced* — the old one ended, a new one started — never
        overwritten, so last year's job still says who was contacted;
      - a compliance position is *superseded*, never edited, so the property's
        history stays readable;
      - a landlord's details are updated on their own record.
    */
    if (record.tenancy) {
      const replaced = await replaceTenancy(
        organisationId,
        propertyId,
        record.tenancy,
        actorUserId,
      );
      if (replaced.status !== "ok") {
        return { line: write.line, outcome: "failed", reason: "Tenant could not be updated." };
      }
      touched = true;
    }

    if (record.compliance) {
      const recorded = await setCompliancePosition(
        organisationId,
        propertyId,
        record.compliance,
        actorUserId,
      );
      if (recorded.status !== "ok") {
        return {
          line: write.line,
          outcome: "failed",
          reason: "Certificate date could not be recorded.",
        };
      }
      touched = true;
    }

    return touched
      ? { line: write.line, outcome: "updated" }
      : {
          line: write.line,
          outcome: "skipped",
          reason: "Nothing in this row differed once it was applied.",
        };
  }

  /*
    **A contactless landlord whose name matched one on file.**

    The preview offered it as a suggestion; this is where the agent's answer is
    applied, and an unanswered row is **held**. A unique matching name is not
    proof of identity — two landlords can share one — and attaching a property
    to the wrong person of that name puts it, and eventually an invoice, in
    front of a stranger with nothing downstream to notice.

    The id comes from inside the signed envelope, so the browser can only
    accept or decline the suggestion; `createProperty` then re-checks that the
    landlord belongs to this agency, so an id from anywhere else matches
    nothing. Declining records a second landlord of that name, which is the
    honest answer when they are different people.
  */
  if (write.landlordChoiceRequired) {
    if (identity === "unanswered") {
      return {
        line: write.line,
        outcome: "skipped",
        reason:
          "A landlord of this name is already on file and this row has no email, so we could not tell whether it is the same person. Import it again and say which.",
      };
    }
    if (identity === "existing" && !write.suggestedLandlordId) {
      // Accepting a suggestion the preview did not make. Nothing to attach to.
      return {
        line: write.line,
        outcome: "skipped",
        reason: "We no longer hold the landlord this row was matched to. Import it again.",
      };
    }
  }

  const attachToExisting =
    identity === "existing" ? write.suggestedLandlordId : undefined;

  const created = await createProperty(
    organisationId,
    attachToExisting
      ? {
          landlordId: attachToExisting,
          property: record.property,
          tenancy: record.tenancy,
          compliance: record.compliance,
        }
      : {
          newLandlord: record.landlord,
          property: record.property,
          tenancy: record.tenancy,
          compliance: record.compliance,
        },
    actorUserId,
  );

  if (created.status === "ok") {
    return { line: write.line, outcome: "created", propertyId: created.value };
  }
  if (created.status === "duplicate") {
    return {
      line: write.line,
      outcome: "skipped",
      reason: "Already in your portfolio — added between the preview and now.",
    };
  }
  return {
    line: write.line,
    outcome: "failed",
    reason: "That property could not be added.",
  };
}

/**
 * Claims the import, writes the rows, records what happened.
 *
 * The claim is first and is the only thing that can make this a no-op. Once it
 * succeeds, every row is attempted — a failure part-way through does not
 * abandon the rest, because the rows after it are perfectly good properties
 * and the agent should not have to re-upload to get them.
 */
export async function commitImport(input: {
  organisationId: string;
  actorUserId: string;
  envelope: ImportEnvelope;
  planDigest: string;
  resolutions: Map<number, Resolution>;
  /** Who the agent said each contactless landlord is. Absent means unanswered. */
  identities?: Map<number, LandlordChoice>;
}): Promise<CommitResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  let importId: string;
  try {
    const [claimed] = await db
      .insert(portfolioImports)
      .values({
        agentOrganisationId: input.organisationId,
        createdByUserId: input.actorUserId,
        planDigest: input.planDigest,
        filename: input.envelope.filename.slice(0, 200),
        rowCount: input.envelope.reviewed,
        status: "running",
      })
      /*
        The unique index on (organisation, digest) decides. `onConflictDoNothing`
        returns no row to the loser, which is exactly the signal needed — and
        the loser then *reads* the winner's result rather than guessing at it.
      */
      .onConflictDoNothing({
        target: [
          portfolioImports.agentOrganisationId,
          portfolioImports.planDigest,
        ],
      })
      .returning({ id: portfolioImports.id });

    if (!claimed) {
      const previous = await readImportByDigest(
        input.organisationId,
        input.planDigest,
      );
      return {
        status: "already_submitted",
        importId: previous?.id ?? "",
        previous: previous?.result ?? null,
      };
    }
    importId = claimed.id;
  } catch {
    return { status: "failed_to_claim" };
  }

  /*
    The portfolio as it is **now**, read once after the claim and before any
    write. Every conflict row is checked against this rather than against the
    preview's snapshot — see the staleness check in `applyRow`.

    One query for the whole import, not one per row: an agent confirming two
    hundred rows must not pay two hundred round trips for a check.

    A failure here yields an empty map, which makes every conflict row skip
    with "this changed" rather than apply on a guess. Refusing to overwrite
    because we could not confirm the state is the right way round.
  */
  const conflictPostcodes = input.envelope.writes
    .filter((write) => write.action === "conflict")
    .map((write) => write.record.property.postcode);
  const current = conflictPostcodes.length
    ? ((await lookupExistingByPostcode(input.organisationId, conflictPostcodes)) ??
      new Map<string, ExistingProperty>())
    : new Map<string, ExistingProperty>();

  const rows: RowOutcome[] = [];
  for (const write of input.envelope.writes) {
    const resolution = input.resolutions.get(write.line) ?? "skip";
    const identity = input.identities?.get(write.line) ?? "unanswered";
    try {
      rows.push(
        await applyRow(
          input.organisationId,
          input.actorUserId,
          write,
          resolution,
          identity,
          current,
        ),
      );
    } catch {
      /*
        A row that threw is recorded and the loop continues. Stopping here
        would leave the remaining rows unattempted and the import row saying
        "running" forever, which is the one state nobody can act on.
      */
      rows.push({
        line: write.line,
        outcome: "failed",
        reason: "That row could not be written.",
      });
    }
  }

  const created = rows.filter((row) => row.outcome === "created").length;
  const updated = rows.filter((row) => row.outcome === "updated").length;
  const skipped = rows.filter((row) => row.outcome === "skipped").length;
  const failed = rows.filter((row) => row.outcome === "failed").length;

  const status =
    failed === 0 ? "done" : created + updated > 0 ? "partial" : "failed";

  try {
    await db
      .update(portfolioImports)
      .set({
        status: status === "done" ? "complete" : status,
        createdCount: created,
        updatedCount: updated,
        skippedCount: skipped,
        failedCount: failed,
        result: { status, created, updated, skipped, failed, rows },
        completedAt: new Date(),
      })
      .where(eq(portfolioImports.id, importId));
  } catch {
    /*
      The properties are written; only the record of the import is not. The
      agent is still told the truth, from the values in hand — losing the
      summary row must not turn a successful import into a reported failure.
    */
  }

  return { status, importId, created, updated, skipped, failed, rows };
}

/** A previous submission of the same plan, for the loser of a double-submit. */
async function readImportByDigest(
  organisationId: string,
  planDigest: string,
): Promise<{ id: string; result: StoredResult | null } | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [row] = await db
      .select({
        id: portfolioImports.id,
        result: portfolioImports.result,
        status: portfolioImports.status,
      })
      .from(portfolioImports)
      // The organisation is in the WHERE as it is everywhere else: a digest is
      // not a secret, and it must not be usable to read another agency's row.
      .where(
        and(
          eq(portfolioImports.agentOrganisationId, organisationId),
          eq(portfolioImports.planDigest, planDigest),
        ),
      )
      .limit(1);

    if (!row) return null;
    return { id: row.id, result: (row.result as StoredResult | null) ?? null };
  } catch {
    return null;
  }
}
