import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  activities,
  complianceCycles,
  customers,
  properties,
  tenancies,
} from "@/lib/db/schema";
import type {
  CompliancePositionInput,
  LandlordInput,
  PropertyInput,
  TenancyInput,
} from "./validation";
import { findDuplicateProperty, isId } from "./queries";
import { tidy } from "./validation";
import { normalisePostcode } from "@/lib/address/format";

/**
 * The canonical form of an address, applied at the write rather than trusted
 * from the caller.
 *
 * The parser already tidies what a form submits, but this module is reachable
 * from anywhere in the server and the uniqueness guarantee has to hold however
 * it was reached — the index compares `lower(house_or_name)` and does not trim.
 */
function canonicalAddress(input: PropertyInput): PropertyInput {
  return {
    ...input,
    houseOrName: tidy(input.houseOrName),
    street: tidy(input.street),
    town: input.town ? tidy(input.town) : null,
    postcode: normalisePostcode(input.postcode),
  };
}

/**
 * Writing to an agency's portfolio.
 *
 * **`organisationId` is the first argument of every function and is written
 * into every row.** It comes from `requireAgent()` and never from the
 * submission. An id that arrives in a form — a landlord to attach a property
 * to, a property to edit — is treated as untrusted: it is used in a `WHERE`
 * alongside the organisation, so an id belonging to another agency simply
 * matches nothing.
 *
 * Multi-row writes go through `db.batch`, which the Neon HTTP driver runs as
 * one transaction. Ids are generated here rather than by the database so the
 * statements do not depend on each other's results and can therefore share a
 * batch — a property, its tenancy, its compliance position and its timeline
 * entry all land together or not at all.
 */

/** Drizzle types `batch` as a non-empty tuple, so the list is built as one. */
type Database = NonNullable<ReturnType<typeof getDb>>;
type BatchItem = Parameters<Database["batch"]>[0][number];

export type MutationResult<T = void> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "duplicate"; existingId?: string }
  | { status: "not_configured" }
  | { status: "failed" };

const failed = <T>(): MutationResult<T> => ({ status: "failed" });

// ---------------------------------------------------------------------------
// Landlords
// ---------------------------------------------------------------------------

export async function createLandlord(
  organisationId: string,
  input: LandlordInput,
  actorUserId: string,
): Promise<MutationResult<string>> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  try {
    /*
      A landlord an agency already has is reused rather than added again. Two
      rows for one person split their properties across two records, and every
      later question — what do they owe, what is due — then has two answers.

      **Matched on a non-empty email, within the organisation, and on nothing
      else.** Two landlords with no email on file are two landlords, not one:
      an absent contact is the absence of information, and treating it as a
      value would collapse every contactless landlord in a portfolio into a
      single record the first import created. That is not a duplicate; it is a
      merge, and it takes their properties with it.

      Matching on **name** is deliberately not done here either. Names repeat,
      and quietly attaching a property to a different J. Smith is worse than
      creating a second record that a person can merge later. Where an agency's
      profile says their names are reliable, the *importer* resolves it
      explicitly and reports an ambiguous name rather than picking — see
      `matchLandlordByName`.
    */
    if (input.email) {
      const [existing] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.agentOrganisationId, organisationId),
            eq(customers.email, input.email),
          ),
        )
        .limit(1);

      if (existing) return { status: "duplicate", existingId: existing.id };
    }

    const id = randomUUID();
    await db.batch([
      db.insert(customers).values({
        id,
        agentOrganisationId: organisationId,
        type: "landlord",
        name: input.name,
        company: input.company,
        email: input.email,
        phone: input.phone,
      }),
      db.insert(activities).values({
        agentOrganisationId: organisationId,
        kind: "landlord.created",
        actor: `user:${actorUserId}`,
        detail: { landlordId: id, name: input.name },
      }),
    ]);

    return { status: "ok", value: id };
  } catch {
    return failed();
  }
}

export async function updateLandlord(
  organisationId: string,
  landlordId: string,
  input: LandlordInput,
  actorUserId: string,
): Promise<MutationResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!isId(landlordId)) return { status: "not_found" };

  try {
    const updated = await db
      .update(customers)
      .set({ ...input, updatedAt: new Date() })
      // The organisation is in the WHERE, so another agency's landlord id
      // matches no row rather than being edited.
      .where(
        and(
          eq(customers.id, landlordId),
          eq(customers.agentOrganisationId, organisationId),
        ),
      )
      .returning({ id: customers.id });

    if (updated.length === 0) return { status: "not_found" };

    await db.insert(activities).values({
      agentOrganisationId: organisationId,
      kind: "landlord.updated",
      actor: `user:${actorUserId}`,
      detail: { landlordId },
    });

    return { status: "ok", value: undefined };
  } catch {
    return failed();
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export type CreatePropertyInput = {
  /** An existing landlord, or the details for a new one. */
  landlordId?: string;
  newLandlord?: LandlordInput;
  property: PropertyInput;
  tenancy: TenancyInput | null;
  compliance: CompliancePositionInput | null;
};

/**
 * Adds a property, and everything the agent entered alongside it.
 *
 * One batch, so a property never exists without the tenancy the agent typed
 * next to it, and a compliance date never survives a property that failed to
 * write.
 */
export async function createProperty(
  organisationId: string,
  input: CreatePropertyInput,
  actorUserId: string,
): Promise<MutationResult<string>> {
  const db = getDb();
  if (!db) return { status: "not_configured" };

  try {
    let landlordId = input.landlordId ?? "";

    if (landlordId) {
      if (!isId(landlordId)) return { status: "not_found" };
      // The landlord must belong to this agency. An id from another one
      // matches nothing here, and the property is refused rather than
      // silently attached to a stranger.
      const [owned] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.id, landlordId),
            eq(customers.agentOrganisationId, organisationId),
          ),
        )
        .limit(1);
      if (!owned) return { status: "not_found" };
    } else if (input.newLandlord) {
      const created = await createLandlord(
        organisationId,
        input.newLandlord,
        actorUserId,
      );
      if (created.status === "duplicate" && created.existingId) {
        // Adding a property for a landlord already on file is the ordinary
        // case, not an error. Reuse them.
        landlordId = created.existingId;
      } else if (created.status === "ok") {
        landlordId = created.value;
      } else {
        return { status: "failed" };
      }
    } else {
      return { status: "not_found" };
    }

    const address = canonicalAddress(input.property);

    const clash = await findDuplicateProperty(
      organisationId,
      address.postcode,
      address.houseOrName,
    );
    if (clash) return { status: "duplicate", existingId: clash };

    const propertyId = randomUUID();
    const first: BatchItem = db.insert(properties).values({
        id: propertyId,
        customerId: landlordId,
        agentOrganisationId: organisationId,
      houseOrName: address.houseOrName,
      street: address.street,
      town: address.town,
      postcode: address.postcode,
      accessNotes: address.accessNotes,
    });
    const rest: BatchItem[] = [];

    if (input.tenancy) {
      rest.push(
        db.insert(tenancies).values({
          propertyId,
          name: input.tenancy.name,
          email: input.tenancy.email,
          phone: input.tenancy.phone,
          startedOn: input.tenancy.startedOn,
          notes: input.tenancy.notes,
        }),
      );
    }

    if (input.compliance) {
      /*
        The position the property arrives with, recorded as a cycle so the
        renewal engine can pick it up later without a second concept. Its
        source is `manual`: a person told us this date, no rule derived it.
      */
      rest.push(
        db.insert(complianceCycles).values({
          propertyId,
          agentOrganisationId: organisationId,
          productId: "cp12",
          inspectionDate: input.compliance.inspectionDate,
          dueDate: input.compliance.dueDate,
          dueDateSource: "manual",
          status: "active",
        }),
      );
    }

    rest.push(
      db.insert(activities).values({
        propertyId,
        agentOrganisationId: organisationId,
        kind: "property.created",
        actor: `user:${actorUserId}`,
        detail: {
          postcode: address.postcode,
          withTenant: Boolean(input.tenancy),
          withCompliance: Boolean(input.compliance),
        },
      }),
    );

    await db.batch([first, ...rest]);

    return { status: "ok", value: propertyId };
  } catch (error) {
    // The unique index is the backstop for two submissions racing the check
    // above. A duplicate is a normal outcome, not a fault.
    if (isUniqueViolation(error)) return { status: "duplicate" };
    return failed();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

export async function updateProperty(
  organisationId: string,
  propertyId: string,
  input: PropertyInput,
  actorUserId: string,
): Promise<MutationResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!isId(propertyId)) return { status: "not_found" };

  try {
    const address = canonicalAddress(input);

    /*
      The uniqueness rule applies to an edit as much as to an insert: moving a
      property onto an address the agency already holds is the same duplicate.
      The index refuses it regardless; checking first makes it a clear message
      rather than a caught constraint.
    */
    const clash = await findDuplicateProperty(
      organisationId,
      address.postcode,
      address.houseOrName,
    );
    if (clash && clash !== propertyId) {
      return { status: "duplicate", existingId: clash };
    }

    const updated = await db
      .update(properties)
      .set({ ...address, updatedAt: new Date() })
      .where(
        and(
          eq(properties.id, propertyId),
          eq(properties.agentOrganisationId, organisationId),
        ),
      )
      .returning({ id: properties.id });

    if (updated.length === 0) return { status: "not_found" };

    await db.insert(activities).values({
      propertyId,
      agentOrganisationId: organisationId,
      kind: "property.updated",
      actor: `user:${actorUserId}`,
    });

    return { status: "ok", value: undefined };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "duplicate" };
    return failed();
  }
}

// ---------------------------------------------------------------------------
// Tenancies
// ---------------------------------------------------------------------------

/**
 * Replaces the current tenancy.
 *
 * **Ends the old one, starts a new one — it never overwrites.** Overwriting
 * loses who we actually contacted last year, and last year's job would then
 * silently re-describe itself. Both statements are in one batch, so a property
 * cannot end up with two open tenancies or none.
 *
 * `newTenancy` of null closes the current one and leaves the property empty,
 * which is a real state between lets.
 */
export async function replaceTenancy(
  organisationId: string,
  propertyId: string,
  newTenancy: TenancyInput | null,
  actorUserId: string,
  endedOn: string = new Date().toISOString().slice(0, 10),
): Promise<MutationResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!isId(propertyId)) return { status: "not_found" };

  try {
    // Ownership is established before anything is written, and by the same
    // rule as everywhere else: the organisation is in the WHERE.
    const [owned] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(
        and(
          eq(properties.id, propertyId),
          eq(properties.agentOrganisationId, organisationId),
        ),
      )
      .limit(1);
    if (!owned) return { status: "not_found" };

    const closeCurrent: BatchItem = db
      .update(tenancies)
      .set({ endedOn, updatedAt: new Date() })
      .where(
        and(eq(tenancies.propertyId, propertyId), isNull(tenancies.endedOn)),
      );
    const rest: BatchItem[] = [];

    if (newTenancy) {
      rest.push(
        db.insert(tenancies).values({
          propertyId,
          name: newTenancy.name,
          email: newTenancy.email,
          phone: newTenancy.phone,
          startedOn: newTenancy.startedOn,
          notes: newTenancy.notes,
        }),
      );
    }

    rest.push(
      db.insert(activities).values({
        propertyId,
        agentOrganisationId: organisationId,
        kind: newTenancy ? "tenancy.replaced" : "tenancy.ended",
        actor: `user:${actorUserId}`,
      }),
    );

    await db.batch([closeCurrent, ...rest]);

    return { status: "ok", value: undefined };
  } catch {
    return failed();
  }
}

/**
 * Records or updates what the property already holds, for **one service**.
 *
 * `productId` defaults to the CP12 because that is what every existing caller
 * means — an imported spreadsheet's `certificate_expiry` column, and the
 * manual "record what they already have" form. It is a parameter rather than a
 * constant because the supersede below is scoped by it: superseding *every*
 * active cycle when recording a CP12 position would quietly cancel a boiler
 * service position that has nothing to do with it.
 */
export async function setCompliancePosition(
  organisationId: string,
  propertyId: string,
  input: CompliancePositionInput,
  actorUserId: string,
  productId: string = "cp12",
): Promise<MutationResult> {
  const db = getDb();
  if (!db) return { status: "not_configured" };
  if (!isId(propertyId)) return { status: "not_found" };

  try {
    const [owned] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(
        and(
          eq(properties.id, propertyId),
          eq(properties.agentOrganisationId, organisationId),
        ),
      )
      .limit(1);
    if (!owned) return { status: "not_found" };

    /*
      Superseding rather than updating, for the same reason a tenancy is
      replaced rather than overwritten: a property's compliance history is
      what makes last year's position answerable.
    */
    await db.batch([
      db
        .update(complianceCycles)
        .set({ status: "superseded", supersededAt: new Date() })
        .where(
          and(
            eq(complianceCycles.propertyId, propertyId),
            eq(complianceCycles.agentOrganisationId, organisationId),
            /*
              **Scoped to the one service.** Without this, recording a CP12
              position would supersede a boiler-service position as well —
              cancelling a record nobody asked about, and leaving the property
              looking as though the service had never been established.
            */
            eq(complianceCycles.productId, productId),
            eq(complianceCycles.status, "active"),
          ),
        ),
      db.insert(complianceCycles).values({
        propertyId,
        agentOrganisationId: organisationId,
        productId,
        inspectionDate: input.inspectionDate,
        dueDate: input.dueDate,
        dueDateSource: "manual",
        status: "active",
      }),
      db.insert(activities).values({
        propertyId,
        agentOrganisationId: organisationId,
        kind: "compliance.recorded",
        actor: `user:${actorUserId}`,
        detail: { dueDate: input.dueDate, productId },
      }),
    ]);

    return { status: "ok", value: undefined };
  } catch {
    return failed();
  }
}
