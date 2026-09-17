"use client";

import { CredentialsForm } from "@/components/auth/CredentialsForm";

/**
 * Staff sign-in.
 *
 * The form itself is shared with the agency portal — one credential check, one
 * component. See `components/auth/CredentialsForm.tsx` for the rule that every
 * failure says the same thing.
 */
export function LoginForm({ next }: { next?: string }) {
  return <CredentialsForm next={next} home="/admin" />;
}
