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
import { inviteUser } from "@/lib/auth/onboarding";
import { revokeCredentials } from "@/lib/auth/credentials";

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
    // Never a password — there is none — and never a token.
    detail: { organisationId, role: "agent_owner" },
  });

  /*
    The account exists; now invite them to set a password.

    Two steps rather than one, because they fail differently. An account with
    no invitation is one click from being fixed and is visible on this screen
    as "invitation outstanding". An invitation for an account that failed to
    create is a link to nothing. So the account is committed first, and a
    failure to queue the message is reported as exactly that — the
    administrator can press *Resend invitation* and nothing is lost.
  */
  const invited = await inviteUser({ userId: result.id });

  await recordAudit({
    actorUserId: session.user.id,
    kind: "account.invitation.queued",
    subjectType: "app_user",
    subjectId: result.id,
    // The outcome, never the credential. No token is even minted yet — the
    // worker does that at send time.
    detail: { organisationId, outcome: invited.status },
  });

  revalidatePath(`/admin/organisations/${organisationId}`);

  return {
    message:
      invited.status === "queued"
        ? "User created. An invitation is on its way — it does not contain a password, and nobody at BSCJ can see the one they choose."
        : "User created, but the invitation could not be queued. Use “Resend invitation”.",
  };
}

/**
 * Sends the invitation again.
 *
 * Deliberately a *control*, not a free action: `inviteUser` refuses a second
 * message within `RESEND_INTERVAL_SECONDS` and is rate limited per account for
 * the day, so an administrator holding the button down queues one message and
 * an automated caller gets nowhere.
 *
 * **Resending does not invalidate the first invitation.** The earlier link may
 * well have arrived, and breaking it to be tidy would strand somebody
 * mid-signup. Each is single-use, purpose-bound and expiring, and redeeming
 * any one of them revokes the rest in the same statement.
 */
export async function resendInvitationAction(form: FormData): Promise<void> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  const organisationId = String(form.get("organisationId") ?? "");
  const userId = String(form.get("userId") ?? "");

  const result = await inviteUser({ userId });

  await recordAudit({
    actorUserId: session.user.id,
    kind: "account.invitation.resent",
    subjectType: "app_user",
    subjectId: userId,
    detail: { organisationId, outcome: result.status },
  });

  revalidatePath(`/admin/organisations/${organisationId}`);
}

/**
 * Withdraws every outstanding invitation for a user.
 *
 * For the case an administrator notices the address was wrong. The rows are
 * revoked rather than deleted, because "an invitation was issued to that
 * address and withdrawn" is exactly what the security log has to be able to
 * answer afterwards.
 */
export async function revokeInvitationAction(form: FormData): Promise<void> {
  const session = await requireAdmin();
  requireCapability(session, "user:manage");

  const organisationId = String(form.get("organisationId") ?? "");
  const userId = String(form.get("userId") ?? "");

  const revoked = await revokeCredentials(userId);

  await recordAudit({
    actorUserId: session.user.id,
    kind: "account.invitation.revoked",
    subjectType: "app_user",
    subjectId: userId,
    detail: { organisationId, revoked },
  });

  revalidatePath(`/admin/organisations/${organisationId}`);
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
