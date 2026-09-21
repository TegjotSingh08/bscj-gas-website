import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadTenantJob } from "@/lib/scheduling/access";
import { readSchedulingSession, SCHEDULING_COOKIE } from "@/lib/scheduling/session";
import { business } from "@/lib/business";
import { bookingConfig } from "@/lib/booking/config";

export const dynamic = "force-dynamic";

export default async function ConfirmedPage() {
  const store = await cookies();
  const session = readSchedulingSession(store.get(SCHEDULING_COOKIE)?.value);
  if (!session) redirect("/schedule");

  const job = await loadTenantJob(session.jobId);
  if (!job?.appointmentStart) redirect("/schedule/appointment");

  const when = job.appointmentStart.toLocaleString("en-GB", {
    timeZone: bookingConfig.timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });

  return (
    /*
      Narrower than the picker and tighter vertically. This page is read once,
      on a phone, and the only thing on it that matters is *when* — so the time
      leads, the detail sits in one compact block, and the instructions are two
      short sentences rather than a paragraph somebody scrolls past.
    */
    <main className="mx-auto max-w-md px-4 py-6">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <p className="text-xs font-extrabold uppercase tracking-wider text-flame-600">
          Confirmed
        </p>
        <h1 className="mt-1 text-xl font-extrabold leading-tight text-navy-900">
          Your appointment is booked
        </h1>

        {/*
          The time, as the largest thing on the page. Somebody reopening this
          the morning of the visit should not have to read to find it.
        */}
        <p className="mt-4 text-2xl font-extrabold leading-tight text-navy-900">
          {when}
        </p>

        <dl className="mt-4 rounded-xl border-2 border-navy-100 bg-navy-50 p-3 text-sm">
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 text-xs font-bold uppercase tracking-wide text-navy-600">
              Property
            </dt>
            <dd className="font-bold text-navy-900">
              {job.address}
              <span className="block font-normal">{job.postcode}</span>
            </dd>
          </div>
          <div className="mt-2 flex gap-3">
            <dt className="w-24 shrink-0 text-xs font-bold uppercase tracking-wide text-navy-600">
              Reference
            </dt>
            <dd className="font-bold text-navy-900">{job.reference}</dd>
          </div>
        </dl>

        <p className="mt-4 text-sm leading-relaxed text-navy-800">
          A Gas Safe registered engineer will call at that time. Someone over 18
          needs to be home, with the boiler reachable.
        </p>
        <p className="mt-2 text-sm text-navy-700">
          There is nothing for you to pay.
        </p>

        {/*
          A tel: link rather than a printed number — this is a phone, and
          changing an appointment is the one thing somebody will come back here
          to do. No change or cancel control: nothing in the product supports a
          tenant doing either from a link, and a button that does not work is
          worse than a number that does.
        */}
        <a
          href={`tel:${business.phone}`}
          className="mt-5 block rounded-xl border-2 border-navy-300 px-4 py-3 text-center text-sm font-bold text-navy-900 hover:border-flame-500"
        >
          Need to change it? Call {business.phoneDisplay}
        </a>
        <p className="mt-2 text-center text-xs text-navy-600">
          Quote {job.reference}. WhatsApp works on the same number.
        </p>
      </div>
    </main>
  );
}
