"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

/**
 * The sign-in form, shared by the staff area and the agency portal.
 *
 * One credential check, one form. Both audiences are `app_user` rows verified
 * by the same server code; only the branding around them and where they land
 * afterwards differ, so both are props rather than a second component.
 *
 * One deliberate rule: **every failure says the same thing.** Distinguishing an
 * unknown address from a wrong password would turn this form into a way to
 * find out who works here, and the server already takes the same time over
 * both — saying so here would give away what that hides. A suspended user and
 * a suspended agency are refused with the same words, for the same reason.
 */

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

/**
 * Only ever a path on this site, so `next` cannot become an open redirect.
 *
 * It must also stay inside the surface the person signed in to: an agency
 * arriving with `?next=/admin` gets their own dashboard, not a redirect loop
 * against a guard that will refuse them anyway.
 */
function safeNext(value: string | undefined, home: string): string {
  if (!value) return home;
  if (!value.startsWith("/") || value.startsWith("//")) return home;
  if (!value.startsWith(home)) return home;
  return value;
}

export function CredentialsForm({
  next,
  home,
}: {
  next?: string;
  /** Where this audience belongs: "/admin" or "/portal". */
  home: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFailed(false);

    const form = new FormData(event.currentTarget);

    try {
      const result = await signIn("credentials", {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        redirect: false,
      });

      if (result?.error) {
        setFailed(true);
        return;
      }
      window.location.assign(safeNext(next, home));
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6">
      {failed && (
        <p
          role="alert"
          className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          Those details were not recognised.
        </p>
      )}

      <div>
        <label htmlFor="email" className="block text-sm font-bold text-navy-900">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className={fieldClass}
        />
      </div>

      <div className="mt-4">
        <label
          htmlFor="password"
          className="block text-sm font-bold text-navy-900"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldClass}
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 w-full rounded-xl bg-flame-500 px-6 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
