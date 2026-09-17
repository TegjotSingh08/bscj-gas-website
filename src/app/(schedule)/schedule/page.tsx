import type { Metadata } from "next";

import { business } from "@/lib/business";
import { LookupForm } from "./LookupForm";

export const metadata: Metadata = {
  title: "Find your appointment",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The way in without a link.
 *
 * Reached by typing the address, or redirected here when a link has expired.
 * `?problem=1` only decides whether the generic message is shown up front; it
 * says nothing about what went wrong, and neither does the form.
 */
export default async function ScheduleEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}) {
  const { problem } = await searchParams;

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6">
        <h1 className="text-xl font-extrabold text-navy-900">
          Find your appointment
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-navy-700">
          Enter the reference from your letter or message, and the postcode of
          the property. If you were sent a link, opening it again is quicker.
        </p>

        <LookupForm hadProblem={problem === "1"} />

        <p className="mt-6 border-t-2 border-navy-100 pt-4 text-xs text-navy-600">
          Stuck? Call or WhatsApp {business.phoneDisplay} and we will book it
          for you.
        </p>
      </div>
    </main>
  );
}
