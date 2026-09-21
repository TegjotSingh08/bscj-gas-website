import "server-only";

import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  complianceCycles,
  customers,
  portfolioImports,
  properties,
  tenancies,
} from "@/lib/db/schema";
import { normalisePostcode } from "@/lib/address/format";

/**
 * What the agency already holds, for the addresses in the file.
 *
 * One query for the whole upload rather than a lookup per row: a 300-row
 * import would otherwise be 300 round trips, and a 300-property agency is
 * exactly the customer this is for.
 *
 * **Scoped to one organisation, in the `WHERE`, without exception.** The
 * organisation comes from `requireAgent()` at the call site and never from the
 * file — a CSV is the most obviously untrusted input in the product, and the
 * one thing it must never be able to name is whose portfolio it is describing.
 * Consumer records have no organisation, so `eq(column, organisationId)`
 * excludes them by construction.
 */

/** The current tenancy is the one that has not ended. */
const CURRENT_TENANCY = and(
  eq(tenancies.propertyId, properties.id),
  isNull(tenancies.endedOn),
);

const ACTIVE_CYCLE = and(
  eq(complianceCycles.propertyId, properties.id),
  eq(complianceCycles.status, "active"),
);

export type ExistingProperty = {
  id: string;
  key: string;
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
  landlordId: string;
  landlordName: string;
  landlordEmail: string | null;
  landlordPhone: string | null;
  landlordCompany: string | null;
  tenancyId: string | null;
  tenantName: string | null;
  tenantEmail: string | null;
  tenantPhone: string | null;
  dueDate: string | null;
  inspectionDate: string | null;
};

/** The key a duplicate is compared on. Mirrors `propertyKey` in validation. */
function keyOf(postcode: string, houseOrName: string): string {
  return `${normalisePostcode(postcode)}|${houseOrName.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * Every property in this agency's portfolio at one of these postcodes.
 *
 * Filtered by **postcode** rather than by the full address key, because the
 * key compares a lower-cased house name that the database would have to
 * compute for every row — and because postcodes are indexed. The exact key
 * comparison happens here, in TypeScript, over a much smaller set.
 */
export async function lookupExistingByPostcode(
  organisationId: string,
  postcodes: readonly string[],
): Promise<Map<string, ExistingProperty> | null> {
  const db = getDb();
  if (!db) return null;

  const unique = [...new Set(postcodes.map(normalisePostcode))].filter(Boolean);
  if (unique.length === 0) return new Map();

  try {
    const rows = await db
      .select({
        id: properties.id,
        houseOrName: properties.houseOrName,
        street: properties.street,
        town: properties.town,
        postcode: properties.postcode,
        landlordId: customers.id,
        landlordName: customers.name,
        landlordEmail: customers.email,
        landlordPhone: customers.phone,
        landlordCompany: customers.company,
        tenancyId: tenancies.id,
        tenantName: tenancies.name,
        tenantEmail: tenancies.email,
        tenantPhone: tenancies.phone,
        dueDate: complianceCycles.dueDate,
        inspectionDate: complianceCycles.inspectionDate,
      })
      .from(properties)
      .innerJoin(customers, eq(customers.id, properties.customerId))
      .leftJoin(tenancies, CURRENT_TENANCY)
      .leftJoin(complianceCycles, ACTIVE_CYCLE)
      .where(
        and(
          eq(properties.agentOrganisationId, organisationId),
          inArray(properties.postcode, unique),
        ),
      );

    const found = new Map<string, ExistingProperty>();
    for (const row of rows) {
      found.set(keyOf(row.postcode, row.houseOrName), {
        ...row,
        key: keyOf(row.postcode, row.houseOrName),
      });
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * The landlords this agency already has, by email.
 *
 * A landlord an agency already holds is **reused**, never duplicated — the
 * same rule `createLandlord` applies, applied here so the preview can say so
 * before anything is written. Two rows for one person split their properties
 * across two records, and every later question then has two answers.
 */
export async function lookupLandlordsByEmail(
  organisationId: string,
  emails: readonly string[],
): Promise<Map<string, { id: string; name: string; email: string }> | null> {
  /*
    Only non-empty addresses are ever looked up. A blank is the absence of a
    contact, not a value to match on — matching on it would make every
    contactless landlord in a portfolio resolve to whichever one happened to be
    created first, taking their properties with them.
  */
  const db = getDb();
  if (!db) return null;

  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(
    Boolean,
  );
  if (unique.length === 0) return new Map();

  try {
    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
      })
      .from(customers)
      .where(
        and(
          eq(customers.agentOrganisationId, organisationId),
          inArray(customers.email, unique),
        ),
      );

    return new Map(
      rows
        .filter((row): row is typeof row & { email: string } => Boolean(row.email))
        .map((row) => [row.email.toLowerCase(), row]),
    );
  } catch {
    return null;
  }
}

/** Kept so a caller cannot accidentally build the key a different way. */
export const existingKeyOf = keyOf;

// ---------------------------------------------------------------------------
// Runs that did not finish
// ---------------------------------------------------------------------------

/**
 * How long a `running` import may legitimately still be running.
 *
 * Far longer than a 500-row import takes, so a slow one is never reported as
 * stranded; short enough that a process which actually died is surfaced while
 * the agent is still thinking about it.
 */
export const UNFINISHED_AFTER_MINUTES = 15;

export type UnfinishedImport = {
  id: string;
  filename: string | null;
  rowCount: number;
  startedAt: Date;
};

/**
 * Imports that were claimed and never reported back.
 *
 * A process that dies mid-loop leaves its row on `running` with its counters
 * still at zero — **and those zeroes are not the truth**, because rows were
 * very likely written before it stopped. Nothing here tries to work out how
 * many: the honest answer is that we do not know, and the way to find out is
 * to upload the file again and read the preview, which compares against what
 * is actually in the portfolio.
 *
 * So this reports the *fact* and deliberately not the counters.
 *
 * **No automatic recovery**, on purpose. Re-uploading is already safe — the
 * per-address unique index refuses a duplicate property, rows already written
 * come back as "already match", and a conflict is re-judged against the
 * current record — so a resumer would add a second path to the same outcome,
 * with its own failure modes, to save one upload.
 */
export async function listUnfinishedImports(
  organisationId: string,
  now = new Date(),
): Promise<UnfinishedImport[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select({
        id: portfolioImports.id,
        filename: portfolioImports.filename,
        rowCount: portfolioImports.rowCount,
        startedAt: portfolioImports.createdAt,
      })
      .from(portfolioImports)
      // The organisation is in the WHERE, as everywhere else.
      .where(
        and(
          eq(portfolioImports.agentOrganisationId, organisationId),
          eq(portfolioImports.status, "running"),
          lt(
            portfolioImports.createdAt,
            new Date(now.getTime() - UNFINISHED_AFTER_MINUTES * 60 * 1000),
          ),
        ),
      )
      .orderBy(desc(portfolioImports.createdAt))
      .limit(5);

    return rows;
  } catch {
    // A notice that cannot be read is not worth failing the page for.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Matching a landlord we have no contact details for
// ---------------------------------------------------------------------------

export type NameMatch =
  /** Exactly one landlord of that name. Safe to attach to. */
  | { outcome: "one"; id: string; name: string }
  /** More than one. A person has to choose; nothing is guessed. */
  | { outcome: "ambiguous"; count: number }
  | { outcome: "none" };

/**
 * Finds a landlord by name, for an export that carries no contact details.
 *
 * **Only used when the agency's profile says their names are reliable**, and
 * even then it resolves rather than guesses: two landlords of one name is
 * reported as ambiguous and the row is held, never attached to whichever came
 * first. Silently picking one puts a property — and eventually an invoice — in
 * front of the wrong person, and nothing downstream would notice.
 *
 * Compared on a tidied, case-folded name within the organisation. It never
 * *creates* a landlord and never invents a contact; it only recognises one the
 * agency already has.
 */
export async function matchLandlordsByName(
  organisationId: string,
  names: readonly string[],
): Promise<Map<string, NameMatch> | null> {
  const db = getDb();
  if (!db) return null;

  const wanted = [...new Set(names.map(normaliseName))].filter(Boolean);
  if (wanted.length === 0) return new Map();

  try {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.agentOrganisationId, organisationId));

    const byName = new Map<string, { id: string; name: string }[]>();
    for (const row of rows) {
      const key = normaliseName(row.name);
      if (!key) continue;
      const bucket = byName.get(key);
      if (bucket) bucket.push(row);
      else byName.set(key, [row]);
    }

    const out = new Map<string, NameMatch>();
    for (const name of wanted) {
      const found = byName.get(name) ?? [];
      if (found.length === 1) {
        out.set(name, { outcome: "one", id: found[0].id, name: found[0].name });
      } else if (found.length > 1) {
        out.set(name, { outcome: "ambiguous", count: found.length });
      } else {
        out.set(name, { outcome: "none" });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** The comparison key for a name. Exported so the planner uses the same one. */
export function normaliseName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
