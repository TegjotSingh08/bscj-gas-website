"use client";

import { CredentialsForm } from "@/components/auth/CredentialsForm";

/** Agency sign-in. The same form and the same rules as the staff area. */
export function PortalLoginForm({ next }: { next?: string }) {
  return <CredentialsForm next={next} home="/portal" />;
}
