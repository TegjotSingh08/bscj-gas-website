"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOut({ callbackUrl: "/portal/login" })}
      className="rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-navy-600"
    >
      Sign out
    </button>
  );
}
