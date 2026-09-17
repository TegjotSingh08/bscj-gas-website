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
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6">
        <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
          Confirmed
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-navy-900">
          Your appointment is booked
        </h1>
        <p className="mt-3 text-base font-bold text-navy-900">{when}</p>
        <p className="mt-1 text-sm text-navy-700">
          {job.address}, {job.postcode}
        </p>

        <div className="mt-5 border-t-2 border-navy-100 pt-4 text-sm leading-relaxed text-navy-700">
          <p>
            A Gas Safe registered engineer will call at that time. Please make
            sure someone over 18 is home and that the boiler and any other gas
            appliances can be reached.
          </p>
          <p className="mt-3">
            Need to change it? Call or WhatsApp {business.phoneDisplay} and
            quote {job.reference}.
          </p>
        </div>
      </div>
    </main>
  );
}
