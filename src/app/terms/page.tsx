import type { Metadata } from "next";
import Link from "next/link";
import { PendingDetail } from "@/components/PendingDetail";
import {
  availability,
  business,
  cancellationPolicy,
  cp12,
  legal,
  serviceAreaCopy,
  serviceRadiusMiles,
} from "@/lib/business";
import {
  CANCELLATION_PERIOD_DAYS,
  TERMS_VERSION,
} from "@/lib/booking/terms";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: `The terms on which ${business.name} provides gas safety certificates, including your right to cancel a booking made online.`,
  alternates: { canonical: "/terms" },
};

/**
 * Customer terms for the V1 CP12 booking service.
 *
 * Written for a landlord or homeowner, not a lawyer. Every statement about
 * cancellation rights traces to the Consumer Contracts (Information,
 * Cancellation and Additional Charges) Regulations 2013 or the Consumer Rights
 * Act 2015 — see docs/CONSUMER_RIGHTS.md for the sources.
 *
 * These terms have NOT been reviewed by a solicitor. Bump TERMS_VERSION in
 * lib/booking/terms.ts whenever anything here changes in substance.
 */

/**
 * The version is the effective date, so it is formatted rather than repeated.
 * The page previously carried "in effect from 22 August 2026" as literal text
 * in two places, which silently contradicted the version once it was bumped.
 */
const TERMS_EFFECTIVE_FROM = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${TERMS_VERSION}T12:00:00Z`));

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-11 scroll-mt-24 text-2xl font-extrabold text-navy-900"
    >
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-base leading-relaxed text-navy-800">{children}</p>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-3 space-y-2 text-base leading-relaxed text-navy-800">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span aria-hidden="true" className="mt-0.5 text-flame-600">
            •
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const emailLink = (address: string) => (
  <a
    href={`mailto:${address}`}
    className="font-semibold text-flame-600 underline underline-offset-4"
  >
    {address}
  </a>
);

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-4xl font-extrabold text-navy-900">
        Terms &amp; Conditions
      </h1>
      <p className="mt-3 text-sm font-semibold text-navy-600">
        Version {TERMS_VERSION} · in effect from {TERMS_EFFECTIVE_FROM}
      </p>

      <div className="mt-8 rounded-2xl border-2 border-navy-200 bg-navy-50 p-5 sm:p-6">
        <p className="text-sm font-bold uppercase tracking-wide text-navy-700">
          The short version
        </p>
        <Bullets
          items={[
            <>
              A gas safety certificate is{" "}
              <strong>{cp12.priceTotalDisplay}</strong>, covering {cp12.includes}
              . Each extra appliance is {cp12.extraApplianceDisplay}.
            </>,
            <>
              You pay after the check is done. We never ask for card details to
              make a booking.
            </>,
            <>
              <strong>{cancellationPolicy.cancelSummary}</strong>
            </>,
            <>
              Because you book online, you also have a legal right to cancel
              within {CANCELLATION_PERIOD_DAYS} days — section 11 explains
              exactly how that works.
            </>,
            <>
              If nobody can let the engineer in, we offer you another
              appointment free of charge. There is no missed-visit charge.
            </>,
          ]}
        />
      </div>

      {/* 1 */}
      <H2 id="about">1. About these terms</H2>
      <P>
        These are the terms on which we provide gas safety checks and
        certificates. They apply when you book with us — through this website,
        by phone or on WhatsApp.
      </P>
      <P>
        We have tried to write them in plain English. If anything here is
        unclear, ask us before you book and we will explain it. If a term could
        be read two ways, the reading that is better for you is the one that
        applies.
      </P>
      <P>
        Nothing in these terms takes away rights the law gives you. Where these
        terms and your legal rights disagree, your legal rights win.
      </P>

      {/* 2 */}
      <H2 id="who-we-are">2. Who we are</H2>
      <P>
        {business.name} is a trading name of {business.legalName}, a company
        registered in England and Wales, company number{" "}
        <PendingDetail value={legal.companyNumber} label="Company number" />.
      </P>
      <P>
        Registered office:{" "}
        <PendingDetail
          value={legal.registeredAddress}
          label="Registered address"
        />
        . This is our registered office, not a shop — we come to you.
      </P>
      <P>
        Gas Safe Register number {business.gasSafeNumber}. You can check it at{" "}
        <a
          href="https://www.gassaferegister.co.uk"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          gassaferegister.co.uk
        </a>
        .
      </P>
      <P>
        Phone {business.phoneDisplay}. Email {emailLink(business.emailGeneral)}{" "}
        for general enquiries, or {emailLink(business.emailBooking)} about a
        booking. You can also message us on WhatsApp on the same number.
      </P>

      {/* 3 */}
      <H2 id="the-service">3. The service</H2>
      <P>
        We carry out a gas safety check and issue a Landlord Gas Safety Record —
        the document most people call a CP12. A Gas Safe registered engineer
        inspects the gas appliances, pipework and flues at the property and
        records whether each appliance is safe to use.
      </P>
      <P>
        A safety check records the condition of the appliances at the time of
        the inspection. It is <strong>not</strong> a service, a repair, or a
        promise that an appliance will keep working. If we find a problem, any
        repair is separate work, quoted separately, and only carried out if you
        agree to it.
      </P>
      <P>
        We work in {serviceAreaCopy.headline.replace(`${business.name} serves `, "")}{" "}
        Our standard online booking area is a {serviceRadiusMiles} mile
        straight-line radius around Wolverhampton, and whether a property falls
        inside it is decided from its postcode when you book. It is a service
        radius, not a promise about how long it takes us to drive to you. We may
        accept work outside that area by arrangement.
      </P>

      {/* 4 */}
      <H2 id="booking">4. Booking an appointment</H2>
      <P>
        When you choose a time on this website we reserve it for you for 30
        minutes while you fill in your details. Reserving a time is not a
        booking. <strong>The contract between us is made when you confirm</strong>{" "}
        and we show you a booking reference — at that point the appointment is in
        the engineer&rsquo;s diary and we email you a confirmation.
      </P>
      <Bullets
        items={[
          `Online appointments need at least ${availability.minimumNoticeHours} hours' notice and can be booked up to ${availability.maximumAdvanceDays} days ahead.`,
          "Need something sooner? Call or message us and we will do what we can.",
          "You must be 18 or over to make a booking.",
          "If a slot is taken while you are filling in the form, we will tell you and offer you another time. Nothing is charged.",
        ]}
      />

      {/* 5 */}
      <H2 id="price">5. Price</H2>
      <P>
        A gas safety certificate is {cp12.priceTotalDisplay}, covering{" "}
        {cp12.includes}. Each additional gas appliance is{" "}
        {cp12.extraApplianceDisplay}. {cp12.priceSentence}
      </P>
      <P>
        The price shown on the review screen before you confirm is the price you
        pay for the inspection. If the property turns out to have more appliances
        than you told us about, the extra-appliance charge applies — but we will
        tell you what the new total is before we do that extra work, and you can
        decline.
      </P>

      <H2 id="inspection-and-repairs">
        5a. What the price covers, and what it does not
      </H2>
      <P>
        This is the part people most often ask about, so it is worth being
        completely clear.
      </P>
      <Bullets
        items={[
          <>
            <strong>
              The {cp12.priceDisplay} is the charge for carrying out the gas
              safety inspection and issuing your record.
            </strong>{" "}
            It is payable once we have carried out the inspection, whether every
            appliance passes or we find something that needs attention. The
            charge is for the work of inspecting, not for a particular result.
          </>,
          <>
            A record showing a problem is still a completed inspection. We will
            not refuse to give you your record because you have not asked us to
            do any repair.
          </>,
          <>
            <strong>
              Repairs, replacement parts and remedial work are not included in
              the {cp12.priceDisplay}.
            </strong>{" "}
            They are a separate service.
          </>,
          <>
            Where the work is something we can do, we will explain what is needed
            and give you a price for it. We will not start any additional work
            until you have agreed to it, and separately agreed work is quoted and
            invoiced separately from the inspection.
          </>,
          <>
            <strong>You are under no obligation to use us for repairs.</strong>{" "}
            You are free to use any Gas Safe registered engineer, or to do
            nothing. Agreeing to a repair is never a condition of receiving your
            gas safety record.
          </>,
          <>
            If an appliance is immediately dangerous, the engineer will ask your
            permission to disconnect it. That is a safety step, not a sales one,
            and it does not commit you to any repair.
          </>,
        ]}
      />
      <P>
        Nothing in this section affects your legal rights, including your right
        to work carried out with reasonable care and skill.
      </P>

      {/* 6 */}
      <H2 id="payment">6. Payment</H2>
      <P>
        {cp12.payment}. Payment is due once the check has been carried out. We
        do not take a deposit, and we do not ask for card details when you book.
      </P>
      <P>
        Confirming a booking does create an obligation to pay for the check once
        we have carried it out. That is why the confirm button on the booking
        page says so.
      </P>

      {/* 7 */}
      <H2 id="your-information">7. The information you give us</H2>
      <P>
        We rely on what you tell us, so please check it. You are responsible for
        giving us the correct property address, a working mobile number, and an
        accurate count of the gas appliances at the property. We ask you to
        confirm the address on screen before the booking is made.
      </P>
      <P>
        If you are a landlord or letting agent booking on behalf of a tenant,
        give us the tenant&rsquo;s name and number so we can arrange access
        directly with them.
      </P>

      {/* 8 */}
      <H2 id="access">8. Access to the property</H2>
      <P>
        Someone aged 18 or over must be at the property to let the engineer in
        and to give access to the boiler, the gas meter and every gas appliance
        being checked. If you are a landlord, arranging that with your tenant is
        your responsibility.
      </P>
      <P>
        Please also tell us in advance about anything that affects getting to
        the property or the appliances — parking restrictions, key safes, gated
        access, pets, or an appliance that is boxed in.
      </P>

      {/* 9 */}
      <H2 id="rescheduling">9. Moving your appointment</H2>
      <P>{cancellationPolicy.rescheduleSummary}</P>
      <P>{cancellationPolicy.noticeRequest}</P>
      <P>
        Contact us by phone, WhatsApp or email at{" "}
        {emailLink(business.emailBooking)} and quote your booking reference.
      </P>

      {/* 10 */}
      <H2 id="cancelling">10. Cancelling — our own policy</H2>
      <P>{cancellationPolicy.cancelSummary}</P>
      <P>
        There is no cancellation fee, no missed-appointment fee and no minimum
        notice period after which you lose the right to cancel with us. Since
        you have not paid anything at the point of booking, there is normally
        nothing to refund.
      </P>
      <P>
        This is our own policy and it sits{" "}
        <em>on top of</em> your legal rights below, not instead of them.
      </P>

      {/* 11 */}
      <H2 id="statutory-cancellation">
        11. Your legal right to cancel within {CANCELLATION_PERIOD_DAYS} days
      </H2>
      <P>
        Because you book without meeting us face to face, this is a
        &ldquo;distance contract&rdquo;. If you are a consumer, that gives you a
        right to cancel under the Consumer Contracts (Information, Cancellation
        and Additional Charges) Regulations 2013.
      </P>
      <P>
        <strong>
          You have the right to cancel this contract within{" "}
          {CANCELLATION_PERIOD_DAYS} days without giving any reason.
        </strong>{" "}
        The cancellation period ends {CANCELLATION_PERIOD_DAYS} days after the
        day you made the booking. Your confirmation email tells you the exact
        date.
      </P>
      <P>
        To cancel, all you have to do is tell us clearly that you want to. Phone{" "}
        {business.phoneDisplay}, message us on WhatsApp, or email{" "}
        {emailLink(business.emailBooking)} — please quote your booking reference.
        You can use the{" "}
        <Link
          href="#cancellation-form"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          cancellation form
        </Link>{" "}
        below if you prefer, but you do not have to, and no particular form of
        words is required.
      </P>
      <P>
        Sending your message before the deadline is enough — it does not matter
        if it reaches us afterwards. If you have paid us anything, we refund it
        within 14 days of being told, using the same payment method you used.
      </P>

      {/* 12 */}
      <H2 id="early-performance">
        12. Appointments inside the {CANCELLATION_PERIOD_DAYS}-day period
      </H2>
      <P>
        Most people want their certificate sooner than{" "}
        {CANCELLATION_PERIOD_DAYS} days away, so most appointments fall inside
        the cancellation period. We are not allowed to start work during that
        period unless you ask us to.
      </P>
      <P>
        That is what the separate tick box on the review screen is for. It only
        appears when your appointment is inside the period, it is never ticked
        for you, and it says that you are asking us to carry out the check on
        your chosen date and that you understand what that means.
      </P>
      <P>
        If your appointment falls <em>after</em> the cancellation period, no such
        request is needed and none is asked for.
      </P>

      {/* 13 */}
      <H2 id="fully-performed">13. Once the check has been carried out</H2>
      <P>
        If you asked us to go ahead inside the cancellation period and we then
        carry out the check in full, your right to cancel that check comes to an
        end — you have had the service you asked for. This only applies because
        you asked, and because we told you clearly, before you confirmed, that
        it would happen.
      </P>
      <P>
        If you cancel <em>part-way</em> through — after we have started but before
        we finish — you pay a proportionate amount for the work actually done,
        not the whole {cp12.priceDisplay}.
      </P>
      <P>
        Simply choosing an appointment date does not, on its own, take away your
        right to cancel.
      </P>

      {/* 14 */}
      <H2 id="failed-access">14. If we cannot get in</H2>
      <P>{cancellationPolicy.failedAccessSummary}</P>
      <P>{cancellationPolicy.failedAccessRepeat}</P>
      <P>
        The engineer will wait a reasonable time and will try the contact number
        you gave us before treating a visit as a failed one.
      </P>

      {/* 15 */}
      <H2 id="our-cancellations">15. If we have to change or cancel</H2>
      <P>
        We give you a start time, not a to-the-minute arrival. Earlier jobs,
        traffic and gas emergencies can move an engineer, and where that happens
        we will contact you as soon as we reasonably can.
      </P>
      <P>
        If we cannot attend, or we are delayed to the point where the
        appointment no longer works for you, we will offer you the earliest
        alternative slot. You will not be charged, and you will not be penalised
        in any way. If you would rather not rebook, you do not have to.
      </P>
      <P>
        We may cancel a booking if the property is outside the area we can
        safely reach, if the information given to us turns out to be wrong, or if
        it would be unsafe or unlawful for us to carry out the work. We will tell
        you why.
      </P>

      {/* 16 */}
      <H2 id="your-responsibilities">16. What we ask of you</H2>
      <Bullets
        items={[
          "Give us accurate details when you book, and tell us if they change.",
          "Make sure someone aged 18 or over is there to let the engineer in.",
          "Give the engineer safe access to the boiler, the meter and every gas appliance.",
          "Tell us about anything at the property that affects safe working.",
          "Pay for the check once it has been carried out.",
        ]}
      />

      {/* 17 */}
      <H2 id="our-responsibilities">17. What we are responsible for</H2>
      <P>
        We will carry out the work with reasonable care and skill, using a Gas
        Safe registered engineer, within a reasonable time. Those are your rights
        under the Consumer Rights Act 2015, and{" "}
        <strong>we do not exclude or limit them</strong>.
      </P>
      <P>
        If the work is not done with reasonable care and skill, you can ask us to
        put it right. If we cannot, or do not do so within a reasonable time and
        without significant inconvenience to you, you can ask for an appropriate
        reduction in what you pay.
      </P>
      <P>
        We are responsible for loss you suffer that is a foreseeable result of us
        breaking these terms or failing to use reasonable care and skill. We do
        not exclude our liability for death or personal injury caused by our
        negligence, for fraud, or for anything else the law does not allow us to
        exclude.
      </P>

      {/* 18 */}
      <H2 id="scope">18. Limits of a gas safety check</H2>
      <Bullets
        items={[
          "The check covers the gas appliances, pipework and flues at the property. It is not a survey of the property and not an electrical check.",
          "It records the position on the day of the inspection.",
          "If an appliance is unsafe, the engineer will explain why and, with your permission, turn it off. If permission to disconnect an immediately dangerous appliance is refused, the engineer is required to report it to the gas emergency service.",
          "We cannot check an appliance we cannot reach, or one that is disconnected, and that will be recorded.",
        ]}
      />

      {/* 19 */}
      <H2 id="complaints">19. If something goes wrong</H2>
      <P>
        Tell us first and give us the chance to put it right. Call{" "}
        {business.phoneDisplay} or email {emailLink(business.emailGeneral)} with
        your booking reference and what happened. We will acknowledge your
        complaint and tell you what we intend to do about it.
      </P>
      <P>
        If you are not satisfied with how we handle it, you can contact Citizens
        Advice, or report a concern about gas work to the Gas Safe Register.
        Using our complaints process does not affect your legal rights.
      </P>

      {/* 20 */}
      <H2 id="privacy">20. Your personal information</H2>
      <P>
        We only collect what we need to arrange and carry out the appointment —
        your name, contact details, the property address, the appliance count and
        anything you tell us about access. We do not ask for card details, dates
        of birth or identity documents.
      </P>
      <P>
        Our{" "}
        <Link
          href="/privacy"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          Privacy Policy
        </Link>{" "}
        explains what we do with it.
      </P>

      {/* 21 */}
      <H2 id="changes">21. Changes to these terms</H2>
      <P>
        We may update these terms. The version that applies to your booking is
        the one you accepted when you made it — the version number is recorded
        against your booking and shown in your confirmation email. Changing these
        terms later does not change a booking you have already made.
      </P>

      {/* 22 */}
      <H2 id="law">22. Which law applies</H2>
      <P>
        These terms are governed by the law of England and Wales. If you are a
        consumer, you can bring court proceedings in the country of the United
        Kingdom in which you live, and nothing here restricts that.
      </P>

      {/* 23 — model cancellation form */}
      <H2 id="cancellation-form">23. Cancellation form</H2>
      <P>
        You do not have to use this form — a clear message by phone, WhatsApp or
        email is enough. It is here because we are required to make it available,
        and because some people prefer it. Copy it into an email to{" "}
        {emailLink(business.emailBooking)}, or post it to our registered office.
      </P>
      <div className="mt-4 rounded-2xl border-2 border-navy-200 bg-navy-50 p-5 text-base leading-relaxed text-navy-800 sm:p-6">
        <p className="font-bold text-navy-900">
          To {business.name}, {legal.registeredAddress}, {business.emailBooking}:
        </p>
        <p className="mt-4">
          I/We [*] hereby give notice that I/We [*] cancel my/our [*] contract
          for the supply of the following service: gas safety check
          (CP12).
        </p>
        <p className="mt-4">Ordered on [date of booking],</p>
        <p className="mt-2">Booking reference,</p>
        <p className="mt-2">Name of consumer(s),</p>
        <p className="mt-2">Address of consumer(s),</p>
        <p className="mt-2">
          Signature of consumer(s) (only if this form is notified on paper),
        </p>
        <p className="mt-2">Date</p>
        <p className="mt-4 text-sm text-navy-600">[*] Delete as appropriate.</p>
      </div>

      <div className="mt-12 rounded-2xl border border-navy-100 bg-white p-5 text-sm leading-relaxed text-navy-700">
        <p>
          <strong className="text-navy-900">Terms version {TERMS_VERSION}</strong>{" "}
          · in effect from {TERMS_EFFECTIVE_FROM}. {business.name} is a trading
          name of{" "}
          {business.legalName}. Questions about these terms:{" "}
          {emailLink(business.emailGeneral)}.
        </p>
      </div>
    </article>
  );
}
