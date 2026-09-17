import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/auth/session";
import { listOrganisationsForAdmin } from "@/lib/organisations/admin";
import { NewOrganisationForm } from "./NewOrganisationForm";

export const metadata: Metadata = {
  title: "Agencies",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Agency accounts.
 *
 * BSCJ opens every account: there is deliberately no public sign-up, so this
 * page is the only way an agency comes into existence.
 */
export default async function AdminOrganisationsPage() {
  await requireAdmin();
  const organisations = await listOrganisationsForAdmin();

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-navy-900">Agencies</h1>
        <Link href="/admin" className="text-sm font-bold text-flame-600 underline">
          Back to dashboard
        </Link>
      </div>

      {organisations === null ? (
        <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
          The database is not configured.
        </p>
      ) : organisations.length === 0 ? (
        <p className="mt-6 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-700">
          No agencies yet. Create one below.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border-2 border-navy-200 bg-white">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-navy-50 text-xs uppercase tracking-wide text-navy-600">
              <tr>
                <th className="px-4 py-3 font-bold">Agency</th>
                <th className="px-4 py-3 font-bold">Contact</th>
                <th className="px-4 py-3 font-bold">Plan</th>
                <th className="px-4 py-3 font-bold">Users</th>
                <th className="px-4 py-3 font-bold">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {organisations.map((organisation) => (
                <tr key={organisation.id} className="hover:bg-navy-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/organisations/${organisation.id}`}
                      className="font-bold text-flame-600 underline"
                    >
                      {organisation.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-navy-700">{organisation.email}</td>
                  <td className="px-4 py-3 text-navy-700">
                    {organisation.plan.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3 text-navy-700">
                    {organisation.userCount}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        organisation.isActive
                          ? "font-bold text-navy-900"
                          : "font-bold text-flame-600"
                      }
                    >
                      {organisation.isActive ? "Active" : "Suspended"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8 rounded-2xl border-2 border-navy-200 bg-white p-6">
        <h2 className="text-lg font-extrabold text-navy-900">New agency</h2>
        <p className="mt-1 text-sm text-navy-600">
          Only the agency name and a contact email are required. Everything else
          can be filled in later, and nothing is invented for a blank field.
        </p>
        <NewOrganisationForm />
      </section>
    </main>
  );
}
