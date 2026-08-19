import { calendarEmbedUrl, sameDayMessaging } from "@/lib/business";

/**
 * Google Calendar Appointment Scheduling embed. Bookings land straight in the
 * engineer's calendar — there is deliberately no custom booking backend.
 */
export function BookingEmbed() {
  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-navy-100 bg-white shadow-sm">
        <iframe
          src={calendarEmbedUrl}
          title="Book a gas safety certificate appointment"
          className="h-[620px] w-full border-0"
          loading="lazy"
        />
      </div>
      <p className="mt-4 rounded-xl bg-navy-50 px-4 py-3 text-sm leading-relaxed text-navy-800">
        {sameDayMessaging.bookingNote}
      </p>
      <noscript>
        <p className="mt-4 text-sm text-navy-800">
          The booking calendar needs JavaScript. Please call or WhatsApp us
          instead and we will book you in.
        </p>
      </noscript>
    </div>
  );
}
