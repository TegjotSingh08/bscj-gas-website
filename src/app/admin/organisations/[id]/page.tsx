import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import { getOrganisationForAdmin } from "@/lib/organisations/admin";
import {
  setOrganisationActiveAction,
  setUserActiveAction,
} from "../actions";
import { NewOwnerForm } from "./NewOwnerForm";

export const metadata: Metadata = {
  title: "Agency",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-navy-100 py-2 last:border-0 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-navy-900 sm:col-span-2 sm:mt-0">
        {value ?? "—"}
      </dd>
    </div>
  );
}

/**
 * One agency: its details, its users, and its active state.
 *
 * Suspending an agency locks out every one of its users on their next request,
 * because `currentIdentity` refuses an agency user whose organisation is
 * inactive. There is no delete — a deactivated agency keeps its jobs,
 * certificates and invoices, and deleting one would take a property's
 * compliance history with it.
 */
export default async function AdminOrganisationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const found = await getOrganisationForAdmin(id);
  if (!found) notFound();

  const { organisation, users, jobCount } = found;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-navy-900">
            {organisation.name}
          </h1>
          <p className="mt-1 text-sm font-bold">
            {organisation.isActive ? (
              <span className="text-navy-700">Active</span>
            ) : (
              <span className="text-flame-600">
                Suspended — nobody at this agency can sign in
              </span>
            )}
          </p>
        </div>
        <Link
          href="/admin/organisations"
          className="text-sm font-bold text-flame-600 underline"
        >
          Back to agencies
        </Link>
      </div>

      <section className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Account</h2>
        <dl className="mt-2">
          <Row label="Contact email" value={organisation.email} />
          <Row label="Phone" value={organisation.phone} />
          <Row label="Legal entity" value={organisation.legalName} />
          <Row label="Company number" value={organisation.companyNumber} />
          <Row
            label="Billing address"
            value={
              [
                organisation.billingLine1,
                organisation.billingLine2,
                organisation.billingTown,
                organisation.billingPostcode,
              ]
                .filter(Boolean)
                .join(", ") || null
            }
          />
          <Row label="Plan" value={organisation.plan.replace(/_/g, " ")} />
          <Row
            label="Remedial authority"
            value={`£${(organisation.remedialAuthorityPence / 100).toFixed(2)}`}
          />
          <Row label="Jobs recorded" value={String(jobCount)} />
          <Row label="Internal notes" value={organisation.notes} />
        </dl>

        <form action={setOrganisationActiveAction} className="mt-4">
          <input type="hidden" name="organisationId" value={organisation.id} />
          <input
            type="hidden"
            name="isActive"
            value={organisation.isActive ? "false" : "true"}
          />
          <button
            type="submit"
            className="rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-navy-600"
          >
            {organisation.isActive ? "Suspend agency" : "Reactivate agency"}
          </button>
        </form>
      </section>

      <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Users</h2>

        {users.length === 0 ? (
          <p className="mt-2 text-sm text-navy-700">
            No users yet. The agency cannot sign in until one exists.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-navy-100">
            {users.map((user) => (
              <li
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <p className="text-sm font-bold text-navy-900">
                    {user.name}{" "}
                    <span className="font-normal text-navy-600">
                      ({user.role.replace(/_/g, " ")})
                    </span>
                  </p>
                  <p className="text-xs text-navy-600">
                    {user.email} ·{" "}
                    {user.isActive ? "active" : "suspended"} ·{" "}
                    {user.lastLoginAt ? "has signed in" : "never signed in"}
                  </p>
                </div>
                <form action={setUserActiveAction}>
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisation.id}
                  />
                  <input type="hidden" name="userId" value={user.id} />
                  <input
                    type="hidden"
                    name="isActive"
                    value={user.isActive ? "false" : "true"}
                  />
                  <button
                    type="submit"
                    className="rounded-lg border-2 border-navy-200 px-3 py-1.5 text-xs font-bold text-navy-900 hover:border-navy-600"
                  >
                    {user.isActive ? "Suspend" : "Reactivate"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 border-t-2 border-navy-100 pt-4">
          <h3 className="text-sm font-extrabold text-navy-900">
            {users.length === 0 ? "Create the first owner" : "Add a user"}
          </h3>
          <NewOwnerForm organisationId={organisation.id} />
        </div>
      </section>
    </main>
  );
}
