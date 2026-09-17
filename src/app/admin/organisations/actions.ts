"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin, requireCapability } from "@/lib/auth/session";
import {
  createOrganisation,
  createOrganisationUser,
  setOrganisationActive,
  setOrganisationUserActive,
} from "@/lib/organisations/admin";
import {
  parseOrganisation,
  parseOwner,
  type FieldErrors,
} from "@/lib/organisations/validation";
import { recordAudit } from "@/lib/audit/record";

/**
 * Agency account management.
 *
 * A server action is a public HTTP endpoint with a generated name — the fact
 * that only an admin page renders a form pointing at it protects nothing. So
 * **every action below starts with `requireAdmin()`**, against a verified
 * session, before it looks at a single field.
 *
 * `requireCapability` is called as well as `requireAdmin`. Today that is
 * redundant, because only an administrator reaches here and an administrator
 * has every capability; it is there so that adding a role which can reach
 * these pages is a change to the matrix rather than a change to every action.
 */

export type ActionState = { errors?: FieldErrors; message?: string };

export async function createOrganisationAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  const parsed = parseOrganisation(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await createOrganisation(parsed.value);

  if (result.status === "not_configured") {
    return { message: "The database is not configured." };
  }
  if (result.status !== "created") {
    return { message: "That agency could not be created." };
  }

  await recordAudit({
    actorUserId: session.user.id,
    kind: "organisation.created",
    subjectType: "agent_organisation",
    subjectId: result.id,
    // The name is business context, not a secret. No contact details.
    detail: { name: parsed.value.name },
  });

  revalidatePath("/admin/organisations");
  redirect(`/admin/organisations/${result.id}`);
}

export async function createOwnerAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  // From the form, and therefore untrusted — but it is only ever used as a
  // lookup key on a table the administrator may read in full anyway.
  const organisationId = String(form.get("organisationId") ?? "");

  const parsed = parseOwner(form);
  if (!parsed.ok) return { errors: parsed.errors };

  const result = await createOrganisationUser(organisationId, parsed.value);

  if (result.status === "duplicate") {
    return { errors: { email: "That email address already has an account." } };
  }
  if (result.status !== "created") {
    return { message: "That user could not be created." };
  }

  await recordAudit({
    actorUserId: session.user.id,
    kind: "organisation.user.created",
    subjectType: "app_user",
    subjectId: result.id,
    // Never the password, and never the hash.
    detail: { organisationId, role: "agent_owner" },
  });

  revalidatePath(`/admin/organisations/${organisationId}`);
  return { message: "User created." };
}

export async function setOrganisationActiveAction(form: FormData): Promise<void> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  const id = String(form.get("organisationId") ?? "");
  const isActive = form.get("isActive") === "true";

  if (await setOrganisationActive(id, isActive)) {
    await recordAudit({
      actorUserId: session.user.id,
      kind: isActive ? "organisation.activated" : "organisation.suspended",
      subjectType: "agent_organisation",
      subjectId: id,
    });
  }

  revalidatePath(`/admin/organisations/${id}`);
  revalidatePath("/admin/organisations");
}

export async function setUserActiveAction(form: FormData): Promise<void> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  const organisationId = String(form.get("organisationId") ?? "");
  const userId = String(form.get("userId") ?? "");
  const isActive = form.get("isActive") === "true";

  if (await setOrganisationUserActive(organisationId, userId, isActive)) {
    await recordAudit({
      actorUserId: session.user.id,
      kind: isActive ? "user.activated" : "user.suspended",
      subjectType: "app_user",
      subjectId: userId,
      detail: { organisationId },
    });
  }

  revalidatePath(`/admin/organisations/${organisationId}`);
}
