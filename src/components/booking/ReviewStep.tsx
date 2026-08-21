"use client";

import { calculatePrice } from "@/lib/booking/pricing";
import { customerTypeLabels } from "@/lib/booking/schema";
import { cp12 } from "@/lib/business";
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

export function ReviewStep({
  date,
  slot,
  details,
  submitting,
  addressConfirmed,
  onAddressConfirmedChange,
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
        Unticked by default, and cleared by any edit. The server requires it
        too, so an altered request cannot skip it.
      */}
      <label className="mt-5 flex items-start gap-3 rounded-xl border-2 border-navy-200 bg-white p-4 text-sm font-semibold text-navy-900">
        <input
          type="checkbox"
          checked={addressConfirmed}
          onChange={(event) => onAddressConfirmedChange(event.target.checked)}
          data-analytics-id="review-confirm-address"
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-2 border-navy-300"
        />
        I confirm that the property address and booking details shown above are
        correct.
      </label>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting || !addressConfirmed}
          data-analytics-id="booking-confirm"
          className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-1"
        >
          {submitting ? "Confirming…" : "Confirm booking"}
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
