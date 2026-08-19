"use client";

import { availability, business, cp12 } from "@/lib/business";

export type ConfirmedBooking = {
  eventId: string;
  dateLabel: string;
  startLabel: string;
  endLabel: string;
  propertyAddress: string;
  postcode: string;
  priceTotal: number;
  priceDisplay: string;
  contactPhone: string;
};

export function Confirmation({ booking }: { booking: ConfirmedBooking }) {
  return (
    <section aria-labelledby="booking-confirmed" role="status">
      <div className="rounded-2xl border-2 border-trust-600 bg-trust-50 p-6 text-center sm:p-8">
        <p
          aria-hidden="true"
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-trust-600 text-3xl text-white"
        >
          ✓
        </p>
        <h2
          id="booking-confirmed"
          className="mt-4 text-3xl font-extrabold text-navy-900"
        >
          You&rsquo;re booked
        </h2>
        <p className="mt-2 text-base text-navy-800">
          Your appointment is confirmed and in the engineer&rsquo;s diary.
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-navy-100 bg-white p-6">
        <dl className="space-y-4">
          <div>
            <dt className="text-sm font-semibold text-navy-600">When</dt>
            <dd className="text-lg font-extrabold text-navy-900">
              {booking.dateLabel}
            </dd>
            <dd className="text-base font-bold text-navy-800">
              {booking.startLabel} – {booking.endLabel}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-semibold text-navy-600">Where</dt>
            <dd className="text-base font-bold text-navy-900">
              {booking.propertyAddress}, {booking.postcode}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-semibold text-navy-600">Price</dt>
            <dd className="text-base font-bold text-navy-900">
              £{booking.priceTotal} total — {cp12.payment.toLowerCase()}
            </dd>
          </div>
        </dl>

        <div className="mt-6 border-t border-navy-100 pt-5 text-sm leading-relaxed text-navy-800">
          <p className="font-bold text-navy-900">What happens next</p>
          <ul className="mt-2 space-y-2">
            <li>
              Someone aged 18 or over needs to be at the property to let the
              engineer in and give access to the boiler, meter and appliances.
            </li>
            <li>
              {cp12.certificateDelivery}.
            </li>
            <li>
              Please write this appointment down — we have not sent you a
              confirmation email.
            </li>
          </ul>
        </div>

        <div className="mt-6 rounded-xl bg-navy-50 p-5">
          <p className="text-sm font-bold text-navy-900">
            Need to change or cancel?
          </p>
          <p className="mt-1 text-sm leading-relaxed text-navy-800">
            Rescheduling is free more than {availability.rescheduleNoticeHours}{" "}
            hours before your slot. Cancellations need at least{" "}
            {availability.cancellationNoticeHours} hours&rsquo; notice. Just get
            in touch.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <a
              href={business.phoneHref}
              data-analytics-id="confirmation-call"
              className="rounded-xl bg-navy-800 px-6 py-3 text-center text-sm font-bold text-white hover:bg-navy-900"
            >
              Call {business.phoneDisplay}
            </a>
            <a
              href={business.whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-id="confirmation-whatsapp"
              className="rounded-xl border-2 border-trust-600 px-6 py-3 text-center text-sm font-bold text-trust-600"
            >
              WhatsApp us
            </a>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-navy-500">
          Booking reference: {booking.eventId.slice(0, 12)}
        </p>
      </div>
    </section>
  );
}
