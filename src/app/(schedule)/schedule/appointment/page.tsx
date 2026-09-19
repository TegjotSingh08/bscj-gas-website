import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadTenantJob } from "@/lib/scheduling/access";
import { readSchedulingSession, SCHEDULING_COOKIE } from "@/lib/scheduling/session";
import { productFor } from "@/lib/booking/products";
import { loadAvailability } from "@/lib/booking/availability";
import { fetchJobDeadline } from "@/lib/scheduling/deadline-lookup";
import { isDeadlinePast, toNotice } from "@/lib/scheduling/deadline";
import { bookingConfig } from "@/lib/booking/config";
import { TenantScheduler } from "./TenantScheduler";

export const dynamic = "force-dynamic";

/**
 * Choosing a time.
 *
 * The job comes from the **signed session**, never from the URL — there is no
 * job id in this route at all, which is the simplest way to guarantee one
 * cannot be substituted. A session that is missing, expired or tampered with
 * sends the tenant back to the entry page.
 *
 * The first set of times is read here rather than fetched by the browser after
 * it paints. It is the same `loadAvailability` the public API route calls, so
 * there is no second version of the rules, and the tenant sees their options
 * in the first response instead of a spinner and a round trip. The picker
 * still refreshes itself from `/api/availability` whenever something changes.
 */
export default async function AppointmentPage() {
  const store = await cookies();
  const session = readSchedulingSession(store.get(SCHEDULING_COOKIE)?.value);
  if (!session) redirect("/schedule");

  const job = await loadTenantJob(session.jobId);
  if (!job) redirect("/schedule?problem=1");

  const product = productFor(job.productId);

  /*
    The job's own appointment is excluded, so a tenant who is changing their
    mind is not blocked by the reservation they already hold.
  */
  const availability = await loadAvailability({
    productId: job.productId,
    ownJobId: job.jobId,
  });

  /*
    The cutoff the picker filters on. Resolved here so the tenant's first view
    already excludes times that miss it — but this is a courtesy, not the
    enforcement: `confirmTenantAppointment` re-reads both dates and decides for
    itself. See `lib/scheduling/deadline.ts`.
  */
  const { deadline } = await fetchJobDeadline(job.jobId, bookingConfig.timeZone);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-extrabold text-navy-900">
        Book your gas safety appointment
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-navy-700">
        {job.requestedBy
          ? `${job.requestedBy} has arranged for us to carry out work at your home.`
          : "We have been asked to carry out work at your home."}{" "}
        Choose a time that suits you.
      </p>

      <div className="mt-5 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
              Property
            </dt>
            <dd className="mt-0.5 text-sm font-bold text-navy-900">
              {job.address}
            </dd>
            <dd className="text-xs text-navy-600">{job.postcode}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
              Appointment
            </dt>
            <dd className="mt-0.5 text-sm text-navy-900">{product.name}</dd>
            <dd className="text-xs text-navy-600">
              About {product.durationMinutes} minutes
            </dd>
          </div>
        </dl>
        {/*
          No price, ever. The tenant is not paying, and showing them what their
          landlord's agent is charged would be nobody's business but the
          agency's.
        */}
        <p className="mt-4 border-t-2 border-navy-100 pt-3 text-xs text-navy-600">
          Reference {job.reference}. There is nothing for you to pay.
        </p>
      </div>

      <TenantScheduler
        product={product}
        existingStart={job.appointmentStart?.toISOString() ?? null}
        initialDays={availability.status === "ok" ? availability.days : null}
        deadline={toNotice(deadline)}
        deadlineOverdue={isDeadlinePast(deadline, new Date())}
      />
    </main>
  );
}
