"use client";

import { calculatePrice } from "@/lib/booking/pricing";
import { customerTypeLabels } from "@/lib/booking/schema";
import { business, cp12 } from "@/lib/business";
import { formatAddressLines } from "@/lib/address/format";
import { formatUkMobileForDisplay, normaliseUkMobile } from "@/lib/booking/contact";
import type { Slot } from "./BookingFlow";
import type { DetailsValues } from "./DetailsForm";

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-navy-100 py-3 last:border-0 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-sm font-semibold text-navy-600">{label}</dt>
      <dd className="text-sm font-bold text-navy-900 sm:text-right">{value}</dd>
    </div>
  );
}

/**
 * One consent control.
 *
 * Every one is unticked on arrival and independently controlled — none is a
 * default the customer has to notice and undo.
 */
function Consent({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-4 flex items-start gap-3 rounded-xl border-2 border-navy-200 bg-white p-4 text-sm leading-relaxed text-navy-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-analytics-id={id}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-2 border-navy-300"
      />
      <span className="font-semibold">{children}</span>
    </label>
  );
}

export function ReviewStep({
  date,
  slot,
  details,
  submitting,
  addressConfirmed,
  onAddressConfirmedChange,
  termsAccepted,
  onTermsAcceptedChange,
  earlyPerformanceRequired,
  earlyPerformanceRequested,
  onEarlyPerformanceRequestedChange,
  onBack,
  onConfirm,
}: {
  date: string;
  slot: Slot;
  details: DetailsValues;
  submitting: boolean;
  /** Never defaults to true — the customer must actively confirm. */
  addressConfirmed: boolean;
  onAddressConfirmedChange: (confirmed: boolean) => void;
  termsAccepted: boolean;
  onTermsAcceptedChange: (accepted: boolean) => void;
  /**
   * True when this appointment falls inside the statutory cancellation period.
   * Display only — the server decides this again for itself.
   */
  earlyPerformanceRequired: boolean;
  earlyPerformanceRequested: boolean;
  onEarlyPerformanceRequestedChange: (requested: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const addressLines = formatAddressLines({
    houseOrName: details.houseOrName,
    street: details.street,
    town: details.town,
    postcode: details.postcode,
  });

  const mobile = normaliseUkMobile(details.phone);
  const mobileDisplay = mobile.ok
    ? formatUkMobileForDisplay(mobile.e164)
    : details.phone;
  const price = calculatePrice(details.applianceCount);

  /** Every required confirmation, and only the ones that actually apply. */
  const canConfirm =
    addressConfirmed &&
    termsAccepted &&
    (!earlyPerformanceRequired || earlyPerformanceRequested);

  const endLabel = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  }).format(new Date(slot.endIso));

  return (
    <section aria-labelledby="review-booking">
      <h2 id="review-booking" className="text-xl font-extrabold text-navy-900">
        Check your booking
      </h2>
      <p className="mt-1 text-sm text-navy-600">
        Nothing is booked until you confirm.
      </p>

      <div className="mt-4 rounded-2xl border-2 border-navy-900 bg-white p-5 sm:p-6">
        <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
          Gas Safety Certificate (CP12)
        </p>
        <p className="mt-2 text-2xl font-extrabold text-navy-900">
          {longDate(date)}
        </p>
        <p className="mt-1 text-lg font-bold text-navy-800">
          {slot.label} – {endLabel}
        </p>

        {/*
          The address gets its own block rather than a table row. It is the
          thing most worth getting wrong, and the customer is the only reliable
          check on it — no free service can prove a house exists at a postcode.
        */}
        <div className="mt-5 rounded-xl border-2 border-navy-200 bg-navy-50 p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-navy-600">
            Property
          </p>
          <p className="mt-2 text-xl font-extrabold leading-snug text-navy-900">
            {addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
        </div>

        <dl className="mt-5">
          <Row label="Name" value={details.fullName} />
          <Row label="Email" value={details.email} />
          <Row label="Mobile" value={mobileDisplay} />
          <Row
            label="You are the"
            value={customerTypeLabels[details.customerType]}
          />
          <Row
            label="Appliances"
            value={`${price.applianceCount} ${price.applianceCount === 1 ? "appliance" : "appliances"}`}
          />
          {details.tenantName || details.tenantPhone ? (
            <Row
              label="Tenant"
              value={`${details.tenantName || "Name not given"}${
                details.tenantPhone ? ` · ${details.tenantPhone}` : ""
              }`}
            />
          ) : null}
          {details.accessNotes ? (
            <Row label="Access notes" value={details.accessNotes} />
          ) : null}
        </dl>

        <div className="mt-5 rounded-xl bg-navy-900 px-5 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm font-bold text-navy-100">Total to pay</span>
            <span className="text-3xl font-extrabold text-flame-400">
              £{price.total}
            </span>
          </div>
          {price.extraCharge > 0 && (
            <p className="mt-1 text-xs text-navy-200">
              £{price.basePrice} for the certificate, plus £{price.extraCharge}{" "}
              for {price.extraAppliances} additional{" "}
              {price.extraAppliances === 1 ? "appliance" : "appliances"}.
            </p>
          )}
          <p className="mt-2 text-xs font-semibold text-navy-100">
            {cp12.payment} — nothing to pay now.
          </p>
        </div>
      </div>

      {/*
        Three separate, independently controlled confirmations, each unticked
        on arrival and cleared by any edit. They are legally distinct — the
        address check, agreement to the terms, and the request to work inside
        the cancellation period — so they are never bundled into one tick.
        The server requires each of them again for itself.
      */}
      <Consent
        id="review-confirm-address"
        checked={addressConfirmed}
        onChange={onAddressConfirmedChange}
      >
        I confirm that the property address and booking details shown above are
        correct.
      </Consent>

      <Consent
        id="review-accept-terms"
        checked={termsAccepted}
        onChange={onTermsAcceptedChange}
      >
        I have read and agree to the{" "}
        {/*
          A new tab, deliberately. The customer is holding a 30-minute
          reservation: navigating this tab away would fire the page's
          abandonment beacon and release their slot.
        */}
        <a
          href="/terms"
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="review-terms-link"
          className="text-flame-600 underline underline-offset-4"
        >
          Terms &amp; Conditions
        </a>{" "}
        <span className="font-normal text-navy-600">(opens in a new tab)</span>.
      </Consent>

      {earlyPerformanceRequired && (
        <Consent
          id="review-early-performance"
          checked={earlyPerformanceRequested}
          onChange={onEarlyPerformanceRequestedChange}
        >
          My appointment is inside my 14-day cancellation period. I am asking{" "}
          {business.name} to carry out the gas safety check on that date, and I
          understand that once the check has been carried out in full I will no
          longer have the right to cancel it. If I cancel after the work has
          started but before it is finished, I will pay a proportionate amount
          for the work already done.
        </Consent>
      )}

      {/*
        Regulation 14: the consumer must explicitly acknowledge that placing
        the order carries an obligation to pay, and where an order is placed
        with a button, the button must say so unambiguously. This applies even
        though payment is deferred until after the visit.
      */}
      <p className="mt-5 rounded-xl bg-navy-50 px-4 py-3 text-sm font-semibold leading-relaxed text-navy-900">
        Confirming this booking creates a contract and an obligation to pay
        £{price.total} for the Gas Safety Certificate. {cp12.payment} — there is
        nothing to pay now.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting || !canConfirm}
          data-analytics-id="booking-confirm"
          className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-1"
        >
          {submitting
            ? "Confirming…"
            : `Confirm booking — agree to pay £${price.total}`}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="rounded-xl border-2 border-navy-200 px-8 py-4 text-base font-bold text-navy-900 hover:border-navy-600 disabled:opacity-60"
        >
          Edit details
        </button>
      </div>
    </section>
  );
}
