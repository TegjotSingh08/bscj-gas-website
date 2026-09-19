import { openCredentialLink } from "../../open-link";

export const dynamic = "force-dynamic";

/**
 * The password-reset link.
 *
 * Identical machinery to the invitation, with a different purpose — and the
 * purpose is what the credential was hashed under, so a reset token opened
 * here works and the same token opened at `/account/invitation/…` does not.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return openCredentialLink(request, token, "password_reset");
}
