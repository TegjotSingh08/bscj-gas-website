import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { SignOutButton } from "./SignOutButton";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The admin shell.
 *
 * Phase 1 deliberately shows no operational data. The tables exist but nothing
 * writes to them yet, and a dashboard of zeroes invites the reading that there
 * is no work on — which would be wrong rather than empty. Phase 2 fills this in
 * once jobs are actually being recorded.
 */
export default async function AdminDashboardPage() {
  const { user } = await requireAdmin();

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            BSCJ Admin
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-navy-900 sm:text-3xl">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-navy-600">
            Signed in as {user.name} ({user.email})
          </p>
        </div>
        <SignOutButton />
      </div>

      <div className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-6">
        <h2 className="text-lg font-extrabold text-navy-900">
          Foundation in place
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-navy-700">
          The V2 database, migrations and staff sign-in are ready, and website
          bookings are now recorded as jobs once their calendar event exists.
          The public booking flow is unchanged: it still writes to Google
          Calendar first, and a database failure cannot fail a booking.
        </p>
        <p className="mt-4">
          <Link
            href="/admin/jobs"
            className="text-sm font-bold text-flame-600 underline"
          >
            View recorded jobs
          </Link>
          {" · "}
          <Link
            href="/admin/organisations"
            className="text-sm font-bold text-flame-600 underline"
          >
            Manage agencies
          </Link>
          {" · "}
          <Link
            href="/admin/reconcile"
            className="text-sm font-bold text-flame-600 underline"
          >
            Reconciliation
          </Link>
        </p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-navy-50 px-4 py-3">
            <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
              Database
            </dt>
            <dd className="mt-1 text-sm font-bold text-navy-900">
              {isDatabaseConfigured() ? "Connected" : "Not configured"}
            </dd>
          </div>
          <div className="rounded-xl bg-navy-50 px-4 py-3">
            <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
              Your role
            </dt>
            <dd className="mt-1 text-sm font-bold text-navy-900">
              {user.role}
            </dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
