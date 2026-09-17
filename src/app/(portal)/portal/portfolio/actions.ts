"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent, requireCapability } from "@/lib/auth/session";
import {
  createLandlord,
  createProperty,
  replaceTenancy,
  setCompliancePosition,
  updateLandlord,
  updateProperty,
} from "@/lib/portfolio/mutations";
import {
  parseCompliance,
  parseLandlord,
  parseProperty,
  parseTenancy,
  type FieldErrors,
} from "@/lib/portfolio/validation";

/**
 * Portfolio mutations.
 *
 * A server action is a public HTTP endpoint with a generated name; that only a
 * portal page renders a form pointing at it protects nothing. So **every
 * action starts with `requireAgent()`**, against a verified session, before it
 * reads a single field — and the organisation it returns is the only one any
 * of them ever writes.
 *
 * **No action reads an organisation id from the form.** There is no hidden
 * field for it and no parser that would accept one. Ids that *do* arrive from
 * the client — a landlord, a property — are untrusted, and the mutation layer
 * uses them in a `WHERE` next to the session's organisation, so one belonging
 * to another agency matches nothing and comes back as `not_found`.
 */

export type ActionState = { errors?: FieldErrors; message?: string };

export async function createPropertyAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const property = parseProperty(form);
  const tenancy = parseTenancy(form);
  const compliance = parseCompliance(form);

  // An existing landlord is chosen by id; a new one arrives as fields. Which
  // of the two it is decides what is validated, so both paths are checked.
  const landlordId = String(form.get("landlordId") ?? "").trim();
  const landlord = landlordId ? null : parseLandlord(form);

  const errors: FieldErrors = {
    ...(property.ok ? {} : property.errors),
    ...(tenancy.ok ? {} : tenancy.errors),
    ...(compliance.ok ? {} : compliance.errors),
    ...(landlord && !landlord.ok ? landlord.errors : {}),
  };
  if (Object.keys(errors).length > 0) return { errors };
  if (!property.ok || !tenancy.ok || !compliance.ok) return { errors };

  const result = await createProperty(
    session.organisationId,
    {
      landlordId: landlordId || undefined,
      newLandlord: landlord?.ok ? landlord.value : undefined,
      property: property.value,
      tenancy: tenancy.value,
      compliance: compliance.value,
    },
    session.user.id,
  );

  if (result.status === "duplicate") {
    return {
      errors: {
        houseOrName:
          "That address is already in your portfolio. Open it from the list instead.",
      },
    };
  }
  if (result.status === "not_found") {
    return { message: "That landlord could not be found." };
  }
  if (result.status !== "ok") {
    return { message: "That property could not be saved." };
  }

  revalidatePath("/portal/portfolio");
  redirect(`/portal/portfolio/${result.value}`);
}

export async function updatePropertyAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const propertyId = String(form.get("propertyId") ?? "");
  const parsed = parseProperty(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await updateProperty(
    session.organisationId,
    propertyId,
    parsed.value,
    session.user.id,
  );

  if (result.status === "duplicate") {
    return { errors: { houseOrName: "That address is already in your portfolio." } };
  }
  // "Not yours" and "no such property" are the same answer, deliberately.
  if (result.status === "not_found") return { message: "Not found." };
  if (result.status !== "ok") return { message: "That change could not be saved." };

  revalidatePath(`/portal/portfolio/${propertyId}`);
  return { message: "Saved." };
}

export async function replaceTenancyAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const propertyId = String(form.get("propertyId") ?? "");
  const parsed = parseTenancy(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await replaceTenancy(
    session.organisationId,
    propertyId,
    parsed.value,
    session.user.id,
  );

  if (result.status === "not_found") return { message: "Not found." };
  if (result.status !== "ok") {
    return { message: "That tenancy could not be saved." };
  }

  revalidatePath(`/portal/portfolio/${propertyId}`);
  return {
    message: parsed.value
      ? "New tenancy recorded. The previous one has been kept."
      : "Tenancy ended. The record has been kept.",
  };
}

export async function setComplianceAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const propertyId = String(form.get("propertyId") ?? "");
  const parsed = parseCompliance(form);
  if (!parsed.ok) return { errors: parsed.errors };
  if (!parsed.value) {
    return { errors: { certificateExpiry: "Enter the expiry date." } };
  }

  const result = await setCompliancePosition(
    session.organisationId,
    propertyId,
    parsed.value,
    session.user.id,
  );

  if (result.status === "not_found") return { message: "Not found." };
  if (result.status !== "ok") return { message: "That date could not be saved." };

  revalidatePath(`/portal/portfolio/${propertyId}`);
  return { message: "Certificate date recorded." };
}

export async function createLandlordAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const parsed = parseLandlord(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await createLandlord(
    session.organisationId,
    parsed.value,
    session.user.id,
  );

  if (result.status === "duplicate") {
    return {
      errors: {
        email: "You already have a landlord with that email address.",
      },
    };
  }
  if (result.status !== "ok") return { message: "That landlord could not be saved." };

  revalidatePath("/portal/landlords");
  redirect(`/portal/landlords/${result.value}`);
}

export async function updateLandlordAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAgent();
  requireCapability(session, "portfolio:write");

  const landlordId = String(form.get("landlordId") ?? "");
  const parsed = parseLandlord(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await updateLandlord(
    session.organisationId,
    landlordId,
    parsed.value,
    session.user.id,
  );

  if (result.status === "not_found") return { message: "Not found." };
  if (result.status !== "ok") return { message: "That change could not be saved." };

  revalidatePath(`/portal/landlords/${landlordId}`);
  return { message: "Saved." };
}
