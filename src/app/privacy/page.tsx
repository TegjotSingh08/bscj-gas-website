import type { Metadata } from "next";
import { PendingDetail } from "@/components/PendingDetail";
import { business, lastUpdated, legal } from "@/lib/business";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${business.name} collects, uses and protects your personal information.`,
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-4xl font-extrabold text-navy-900">Privacy Policy</h1>
      <p className="mt-3 text-sm text-navy-600">Last updated: {lastUpdated}</p>

      <p className="mt-8 text-base leading-relaxed text-navy-800">
        This policy explains what personal information {business.name} collects
        when you book a gas safety check or get in touch, what we do with it,
        and what rights you have over it.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">Who we are</h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        {business.name} is a trading name of {business.legalName}, a company
        registered in England and Wales, company number{" "}
        <PendingDetail value={legal.companyNumber} label="Company number" />,
        registered address{" "}
        <PendingDetail value={legal.registeredAddress} label="Registered address" />.
        We are the data controller for the information described here. You can
        contact us at{" "}
        <a
          href={`mailto:${business.emailGeneral}`}
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          {business.emailGeneral}
        </a>
        .
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        What we collect
      </h2>
      <ul className="mt-3 space-y-2 text-base leading-relaxed text-navy-800">
        <li>
          <strong>Booking details</strong> — your name, telephone number, email
          address, the property address, the number and type of gas appliances,
          and any access or parking notes you give us.
        </li>
        <li>
          <strong>Tenant details</strong> — if you are a landlord and your
          tenant will be giving us access, the name and contact number you
          provide for them.
        </li>
        <li>
          <strong>Enquiry details</strong> — whatever you tell us when you call,
          message or email.
        </li>
        <li>
          <strong>Job records</strong> — the results of the safety check and the
          certificate issued.
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        Why we use it and our legal basis
      </h2>
      <ul className="mt-3 space-y-2 text-base leading-relaxed text-navy-800">
        <li>
          <strong>To carry out the work you booked</strong> — arranging the
          appointment, attending the property, issuing your certificate and
          taking payment. Legal basis: performance of a contract.
        </li>
        <li>
          <strong>To meet our legal duties</strong> — gas safety records must be
          kept for at least two years under the Gas Safety (Installation and
          Use) Regulations 1998, and business records are kept as tax law
          requires. Legal basis: legal obligation.
        </li>
        <li>
          <strong>To answer your enquiries</strong> — replying when you contact
          us. Legal basis: legitimate interests.
        </li>
      </ul>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        We do not sell your information, and we do not use it for advertising.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        If you are booking on behalf of a tenant
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        When you give us a tenant&rsquo;s contact details, please make sure they
        know you have done so and why. We use those details only to arrange
        access for the safety check.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        Who else handles your information
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Our online booking uses <strong>Google Calendar Appointment
        Scheduling</strong>. When you book a slot, the details you enter into
        that booking form are processed by Google and stored in our calendar.
        Google&rsquo;s handling of that data is covered by the{" "}
        <a
          href="https://policies.google.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          Google Privacy Policy
        </a>
        .
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Our email is provided through Google Workspace, and this website is
        hosted by Vercel. If you message us on WhatsApp, that conversation is
        handled by WhatsApp under its own terms.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        How long we keep it
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Gas safety records are kept for at least two years, as the regulations
        require. Records needed for accounting are kept for six years. General
        enquiries that do not become bookings are deleted once they are no
        longer needed.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        Your rights
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        Under UK data protection law you can ask us for a copy of the personal
        information we hold about you, ask us to correct it if it is wrong, ask
        us to delete it where we are not required to keep it, object to or
        restrict how we use it, and ask for it in a portable format. Email{" "}
        <a
          href={`mailto:${business.emailGeneral}`}
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          {business.emailGeneral}
        </a>{" "}
        and we will respond within one month.
      </p>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        If you are unhappy with how we have handled your information you can
        complain to the Information Commissioner&rsquo;s Office at{" "}
        <a
          href="https://ico.org.uk"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          ico.org.uk
        </a>{" "}
        or on 0303 123 1113.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">Cookies</h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        This website does not set advertising or analytics cookies. The embedded
        Google booking calendar may set cookies of its own when it loads, which
        are governed by Google&rsquo;s policy linked above.
      </p>

      <h2 className="mt-10 text-2xl font-extrabold text-navy-900">
        Changes to this policy
      </h2>
      <p className="mt-3 text-base leading-relaxed text-navy-800">
        If we change how we handle personal information we will update this page
        and the date at the top.
      </p>
    </article>
  );
}
