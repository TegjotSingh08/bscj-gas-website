"use server";

import { revalidatePath } from "next/cache";

import { requireAgent, requireCapability } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import { rateLimit } from "@/lib/booking/rate-limit";
import { COLUMNS, type ColumnKey } from "@/lib/portfolio/import/columns";
import { resolveHeaders, type ResolvedColumn } from "@/lib/portfolio/import/mapping";
import { readProfile } from "@/lib/portfolio/import/profile-store";
import { profileDigest, type ImportProfile } from "@/lib/portfolio/import/profile";
import {
  describeCsvProblem,
  LIMITS,
  parseCsv,
} from "@/lib/portfolio/import/csv";
import {
  buildImportPlan,
  type ImportPlan,
  type LandlordChoice,
  type Resolution,
} from "@/lib/portfolio/import/plan";
import {
  digestFor,
  envelopeFor,
  openEnvelope,
  sealEnvelope,
} from "@/lib/portfolio/import/envelope";
import {
  lookupExistingByPostcode,
  lookupLandlordsByEmail,
  matchLandlordsByName,
} from "@/lib/portfolio/import/lookup";
import { commitImport, type RowOutcome } from "@/lib/portfolio/import/commit";
import type { RowValues } from "@/lib/portfolio/import/rows";

/**
 * Uploading, reviewing and confirming a portfolio import.
 *
 * Two actions, and the separation between them is the feature. The first reads
 * a file and **writes nothing**; the second writes what the first showed, and
 * only what the agent then confirmed.
 *
 * Both start with `requireAgent()`, against a verified session, because a
 * server action is a public HTTP endpoint with a generated name. **The
 * organisation comes from that session and from nowhere else** — not from the
 * form, not from the envelope, not from the file. A CSV is the most obviously
 * untrusted input in the product and the one thing it must never be able to
 * say is whose portfolio it is describing.
 */

export type PreviewState = {
  /** A problem with the file as a whole. */
  error?: string;
  /** Column headers that could not be matched, reported rather than ignored. */
  unknownColumns?: string[];
  /** How every heading in the file was understood, for the mapping panel. */
  resolved?: ResolvedColumn[];
  /** True when BSCJ has configured a profile for this agency. */
  profileConfigured?: boolean;
  /** The profile in force, so the preview can say how the file was read. */
  profile?: ImportProfile;
  /** Keys claimed by two headings — a fault in the file or the mapping. */
  duplicatedColumns?: string[];
  /** Required columns the file does not have at all. */
  missingColumns?: string[];
  plan?: ImportPlan;
  /** The signed plan, carried in a hidden field to the confirmation. */
  sealed?: string;
  filename?: string;
};

export type ConfirmState = {
  error?: string;
  done?: {
    status: string;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    rows: RowOutcome[];
    /** True when this submission was a repeat of one already processed. */
    repeat?: boolean;
  };
};

/**
 * Reads the file and builds the plan. **Writes nothing.**
 *
 * Every limit is enforced before any parsing: the size on the bytes, the row
 * count during the parse, the cell length per cell. A file that exceeds one is
 * refused with a sentence saying which and what to do, never truncated —
 * silently importing the first 500 rows of a 900-row file is the worst
 * available outcome, because it looks like success.
 */
export async function previewImportAction(
  _previous: PreviewState,
  form: FormData,
): Promise<PreviewState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  /*
    Rate limited per user rather than per IP: this is an authenticated endpoint
    that reads a file and runs a batch of queries, and one agency behind one
    office IP is the normal case rather than the suspicious one.
  */
  const limited = await rateLimit(`import-preview:${session.user.id}`, 20, 600);
  if (!limited.ok) {
    return { error: "Too many uploads just now. Wait a few minutes and try again." };
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a CSV file to upload." };
  }

  /*
    Checked before the bytes are read into memory. A `File` from a form knows
    its size without being consumed, so an oversized upload costs one
    comparison rather than a buffer.
  */
  if (file.size > LIMITS.bytes) {
    return {
      error: describeCsvProblem({ kind: "too_large", bytes: file.size }),
    };
  }

  /*
    The filename is **presentation only**, and is treated as hostile: it is
    never used as a path, never written to disk, and is truncated before it
    goes anywhere near a database column or the screen. A name ending `.xlsx`
    is refused by name, because the honest answer is a one-line instruction
    rather than a parser producing nonsense from zipped XML.
  */
  const filename = file.name.slice(0, 200);
  if (/\.(xlsx|xls|numbers|ods)$/i.test(filename)) {
    return {
      error:
        "That is a spreadsheet, not a CSV. Open it, choose File → Save As, and pick CSV — then upload that.",
    };
  }

  const parsed = parseCsv(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return { error: describeCsvProblem(parsed.problem), filename };

  const { header, rows, lineNumbers } = parsed.table;

  /*
    Headers are matched to columns once, and anything unmatched is **reported**.
    A column quietly ignored is how a hundred tenant email addresses go missing
    without anybody noticing until the invitations do not arrive.
  */
  /*
    What each heading means, in precedence order: what the agent chose on this
    upload, then this agency's saved mapping, then the template and its
    aliases. The organisation comes from the session — a file cannot name whose
    mapping to load.
  */
  const { profile, configured } = await readProfile(session.organisationId);
  /*
    The agency uploads; it does not decide what its columns mean. BSCJ reviews
    the spreadsheet once and records the reading, so every upload afterwards is
    the same reading — and an agent cannot change, by accident or otherwise,
    what a column is taken to be. The profile is shown in full on the preview.
  */
  const resolution = resolveHeaders({
    headers: header,
    saved: profile.columns,
  });

  const present = new Set(
    Object.keys(resolution.byKey) as ColumnKey[],
  );

  /*
    A combined address satisfies the four separate address columns. An export
    with one address column is the common shape and must not be refused for
    lacking headings it was never going to have — the split is checked per row,
    where a failure names the actual cell.
  */
  if (present.has("fullAddress")) {
    for (const key of ["houseOrName", "street", "postcode"] as ColumnKey[]) {
      present.add(key);
    }
  }

  const missingColumns = COLUMNS.filter(
    (column) => column.required && !present.has(column.key),
  ).map((column) => column.header);

  const unknownColumns = resolution.unmapped.map((header) =>
    header.slice(0, 60),
  );

  if (missingColumns.length > 0 || resolution.duplicated.length > 0) {
    return {
      error:
        resolution.duplicated.length > 0
          ? "Two columns in that file mean the same thing. Map one of them to something else, or remove it."
          : "That file is missing information the import needs. Map the columns below, or download the template and use its headings.",
      missingColumns: missingColumns.length ? missingColumns : undefined,
      duplicatedColumns: resolution.duplicated.length
        ? resolution.duplicated.map(
            (key) => COLUMNS.find((column) => column.key === key)?.header ?? key,
          )
        : undefined,
      unknownColumns: unknownColumns.length ? unknownColumns : undefined,
      resolved: resolution.columns,
      profileConfigured: configured,
      profile,
      filename,
    };
  }

  const mapping: (ColumnKey | null)[] = resolution.columns.map(
    (column) => column.key,
  );

  const valued = rows.map((values, index) => {
    const record: RowValues = {};
    mapping.forEach((key, column) => {
      if (key) record[key] = values[column];
    });
    return { line: lineNumbers[index] ?? index + 2, values: record };
  });

  if (valued.length === 0) {
    return { error: "That file has headings but no rows.", filename };
  }

  /*
    What the agency already holds, read once for the whole file and **scoped to
    this organisation in the WHERE**. The postcodes come from the file and are
    the subject of the query, never its authority.
  */
  const postcodes = valued.map((row) => row.values.postcode ?? "");
  const existing = await lookupExistingByPostcode(
    session.organisationId,
    postcodes,
  );
  if (!existing) {
    return { error: "Your portfolio could not be read just now. Try again.", filename };
  }

  const emails = valued.map((row) => row.values.landlordEmail ?? "");
  const landlords = await lookupLandlordsByEmail(session.organisationId, emails);

  /*
    Only when the profile says this agency's names are reliable, and only for
    rows that carry no email — a name match is weaker evidence than an address
    and is never used where an address exists.
  */
  const landlordsByName =
    profile.landlordMatch === "match_existing_by_name"
      ? ((await matchLandlordsByName(
          session.organisationId,
          valued
            .filter((row) => !(row.values.landlordEmail ?? "").trim())
            .map((row) => row.values.landlordName ?? ""),
        )) ?? undefined)
      : undefined;

  const plan = buildImportPlan({
    rows: valued,
    existing,
    existingLandlordEmails: new Set(landlords ? [...landlords.keys()] : []),
    landlordsByName,
    profile,
  });

  const envelope = envelopeFor({
    organisationId: session.organisationId,
    filename,
    rows: plan.rows,
    /*
      The reading this plan was computed under. Compared at confirmation, so a
      profile BSCJ corrects in between invalidates the preview rather than
      silently writing under a reading nobody holds any more.
    */
    profileDigest: profileDigest(profile),
  });

  await recordAudit({
    actorUserId: session.user.id,
    kind: "portfolio.import.previewed",
    subjectType: "agent_organisation",
    subjectId: session.organisationId,
    // Counts, never contents. No address, no landlord, no tenant.
    detail: { rows: plan.rows.length, counts: plan.counts },
  });

  return {
    plan,
    sealed: sealEnvelope(envelope),
    filename,
    unknownColumns: unknownColumns.length ? unknownColumns : undefined,
    resolved: resolution.columns,
    profileConfigured: configured,
    profile,
  };
}


/**
 * Writes the reviewed plan.
 *
 * Everything written comes out of the **signed envelope** — what the agent saw
 * — rather than from any field the browser could have edited. The only thing
 * taken from the submission is the per-row resolution, and an absent one is
 * read as `skip`: a lost checkbox must never become permission to overwrite a
 * tenant.
 */
export async function confirmImportAction(
  _previous: ConfirmState,
  form: FormData,
): Promise<ConfirmState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const sealed = typeof form.get("plan") === "string"
    ? String(form.get("plan"))
    : undefined;

  /*
    The profile as it is **now**. `openEnvelope` refuses a plan computed under
    a different one, so a correction BSCJ makes between preview and confirm
    invalidates the review instead of writing under a superseded reading.
  */
  const { profile } = await readProfile(session.organisationId);

  const envelope = openEnvelope(
    sealed,
    session.organisationId,
    new Date(),
    profileDigest(profile),
  );
  if (!envelope) {
    return {
      error:
        "That review is no longer valid. It may have expired, or the import settings for your agency may have changed. Upload the file again and check the preview.",
    };
  }

  /*
    Resolutions, read as an allow-list. Anything that is not exactly "update"
    is `skip`, so a malformed, missing or unexpected value fails towards
    changing nothing.
  */
  const resolutions = new Map<number, Resolution>();
  /*
    Who the agent said each contactless landlord is, read the same way: an
    allow-list of two answers, and anything else — missing, malformed, a radio
    nobody touched — is `unanswered`, which **holds** the row. A lost control
    must never become permission to attach a property, and the invoices that
    follow it, to somebody who merely shares a name.

    Note what is *not* read here: no landlord id. The only id in play is the
    one inside the signed envelope, so the browser can accept or decline the
    suggestion the preview made and cannot name a different landlord.
    `createProperty` then re-checks that the landlord belongs to this agency.
  */
  const identities = new Map<number, LandlordChoice>();
  for (const write of envelope.writes) {
    const chosen = form.get(`resolution-${write.line}`);
    resolutions.set(write.line, chosen === "update" ? "update" : "skip");

    const identity = form.get(`landlord-${write.line}`);
    identities.set(
      write.line,
      identity === "existing" ? "existing" : identity === "new" ? "new" : "unanswered",
    );
  }

  const digest = digestFor(envelope, resolutions, identities);

  const result = await commitImport({
    organisationId: session.organisationId,
    actorUserId: session.user.id,
    envelope,
    planDigest: digest,
    resolutions,
    identities,
  });

  if (result.status === "not_configured") {
    return { error: "The database is not configured." };
  }
  if (result.status === "failed_to_claim") {
    return { error: "That import could not be started. Try again." };
  }

  if (result.status === "already_submitted") {
    /*
      The retry-safe path, and it reports rather than refuses. A refresh, a
      double-click or a second tab arrives here; the agent is shown what the
      first submission actually did instead of a warning that tells them
      nothing about whether their properties are in.
    */
    revalidatePath("/portal/portfolio");
    return {
      done: {
        status: result.previous?.status ?? "done",
        created: result.previous?.created ?? 0,
        updated: result.previous?.updated ?? 0,
        skipped: result.previous?.skipped ?? 0,
        failed: result.previous?.failed ?? 0,
        rows: result.previous?.rows ?? [],
        repeat: true,
      },
    };
  }

  await recordAudit({
    actorUserId: session.user.id,
    kind: "portfolio.import.confirmed",
    subjectType: "agent_organisation",
    subjectId: session.organisationId,
    detail: {
      importId: result.importId,
      status: result.status,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
    },
  });

  revalidatePath("/portal/portfolio");

  return {
    done: {
      status: result.status,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      rows: result.rows,
    },
  };
}
