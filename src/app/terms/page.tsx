import type { Metadata } from "next";
import { PendingDetail } from "@/components/PendingDetail";
import {
  availability,
  business,
  cp12,
  lastUpdated,
  legal,
  serviceAreaCopy,
  serviceRadiusMiles,
} from "@/lib/business";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The terms on which ${business.name} provides gas safety certificates and related work.`,
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-4xl font-extrabold text-navy-900">
        Terms of Service
      </h1>
      <p className="mt-3 text-sm text-navy-600">Last updated: {lastUpdated}</p>

      <p className="mt-8 text-base leading-relaxed text-navy-800">
        These terms apply when you book gas work with {business.name}, a trading
        name of {business.legalName}, company number{" "}
        <PendingDetail value={legal.companyNumber} label="Company number" />,
        registered address{" "}
        <PendingDetail value={legal.registeredAddress} label="Registered address" />.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        1. What we provide
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        We carry out gas safety checks and issue Landlord Gas Safety Records
        (commonly called CP12 certificates), together with related gas work,
        through a Gas Safe registered engineer. Our Gas Safe Register number is{" "}
        {business.gasSafeNumber}.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        2. Prices
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        A gas safety certificate is {cp12.priceDisplay}, covering{" "}
        {cp12.includes}. Each additional gas appliance is{" "}
        {cp12.extraApplianceDisplay}. If the property turns out to have more
        appliances than you told us when booking, the additional charge applies
        and we will tell you before carrying out the extra work.
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Any work beyond the safety check — repairs, parts or remedial work — is
        quoted separately and only carried out with your agreement.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        3. Payment
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        {cp12.payment}. Payment is due once the safety check has been carried
        out. No deposit is taken at the time of booking.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        4. Booking, cancelling and rescheduling
      </h2>
      <ul className="mt-3 space-y-2 text-base leading-relaxed text-navy-800">
        <li>
          Online bookings need at least {availability.minimumNoticeHours}{" "}
          hours&rsquo; notice and can be made up to{" "}
          {availability.maximumAdvanceDays} days ahead.
        </li>
        <li>
          You may reschedule free of charge if there is more than{" "}
          {availability.rescheduleNoticeHours} hours between the request and
          your appointment time.
        </li>
        <li>
          Cancellations require at least {availability.cancellationNoticeHours}{" "}
          hours&rsquo; notice. Appointments cannot be cancelled inside that
          window.
        </li>
        <li>
          If we need to change your appointment we will contact you as soon as
          we can and offer you the earliest alternative slot.
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        5. Access to the property
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Someone aged 18 or over must be present to let the engineer in and to
        provide access to the boiler, the gas meter and every gas appliance
        being checked. If you are a landlord, it is your responsibility to
        arrange access with your tenant and to give us accurate contact details
        for whoever will be there.
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        If the engineer cannot get in, or cannot reach the appliances, we may
        not be able to complete the check and a further visit may be needed.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        6. The safety check and your certificate
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        A gas safety check records the condition of the appliances at the time
        of the inspection. It is not a service, a repair, or a warranty that an
        appliance will continue to work.
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        {cp12.certificateDelivery}.
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        If an appliance is found to be unsafe, the engineer will explain the
        problem and, with your permission, turn it off. Where permission to
        disconnect an immediately dangerous appliance is refused, the engineer
        is required to report it to the relevant gas emergency service.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        7. Where we work
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        {serviceAreaCopy.headline} Our standard online booking area is a{" "}
        {serviceRadiusMiles} mile straight-line radius around Wolverhampton,
        and whether a property falls inside it is decided from its postcode
        when you book. We may accept work outside that area at our discretion.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        8. Your legal rights
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Nothing in these terms affects your statutory rights as a consumer,
        including your rights under the Consumer Rights Act 2015 to work carried
        out with reasonable care and skill. If you are unhappy with the work,
        contact us first at{" "}
        <a
          href={`mailto:${business.emailGeneral}`}
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          {business.emailGeneral}
        </a>{" "}
        so we have the chance to put it right.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        9. Governing law
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        These terms are governed by the law of England and Wales.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        10. Contact
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        {business.name}, {business.phoneDisplay},{" "}
        <a
          href={`mailto:${business.emailGeneral}`}
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          {business.emailGeneral}
        </a>
        .
      </p>
    </article>
  );
}
