import {
  calendarDirectUrl,
  calendarEmbedUrl,
  sameDayMessaging,
} from "@/lib/business";

/**
 * RETAINED AS A ROLLBACK ONLY — not rendered anywhere.
 *
 * /book now uses the BSCJ booking flow in src/components/booking/. This
 * component is the previous Google Calendar iframe, kept until a real booking
 * has been made through the new flow on the live site. Delete it after that
 * (see docs/LAUNCH_CHECKLIST.md); until then it is a one-line way back.
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
      <p className="mt-3 text-center text-sm text-navy-700">
        Calendar not loading?{" "}
        <a
          href={calendarDirectUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="booking-direct-fallback"
          className="font-bold text-flame-600 underline underline-offset-4"
        >
          Open the booking page directly
        </a>
        .
      </p>
      <noscript>
        <p className="mt-4 text-sm text-navy-800">
          The booking calendar needs JavaScript. Use the direct booking link
          above, or call or WhatsApp us and we will book you in.
        </p>
      </noscript>
    </div>
  );
}
