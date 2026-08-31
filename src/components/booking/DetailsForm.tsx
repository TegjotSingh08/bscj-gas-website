"use client";

import { useState } from "react";

import { customerTypeLabels, customerTypes } from "@/lib/booking/schema";
import { calculatePrice, MAX_APPLIANCES } from "@/lib/booking/pricing";
import type { Product } from "@/lib/booking/products";
import {
  firstInvalidField,
  hasErrors,
  validateDetails,
  type DetailsErrors,
} from "@/lib/booking/details";
import { AddressFields } from "./AddressFields";
import { PhoneField } from "./PhoneField";

export type DetailsValues = {
  fullName: string;
  email: string;
  phone: string;
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
  customerType: (typeof customerTypes)[number];
  applianceCount: number;
  tenantName: string;
  tenantPhone: string;
  accessNotes: string;
  /** Honeypot. Hidden from real users. */
  company: string;
};

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 placeholder:text-navy-400 focus:border-flame-500 focus:outline-none";

const labelClass = "block text-sm font-bold text-navy-900";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-sm font-semibold text-flame-600">{message}</p>
  );
}

export function DetailsForm({
  values,
  product,
  fieldErrors,
  onPatch,
  onBack,
  onContinue,
}: {
  values: DetailsValues;
  /** The service being booked. Every figure below is derived from it. */
  product: Product;
  fieldErrors: Record<string, string>;
  /**
   * Applies a partial update. A patch rather than a whole object because two
   * fields changing in the same tick must both survive — spreading a captured
   * `values` snapshot silently discards the first.
   */
  onPatch: (patch: Partial<DetailsValues>) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [addressReady, setAddressReady] = useState(false);
  /**
   * Set by a failed Continue. Until then the form stays quiet — nobody wants a
   * red "enter your name" before they have had the chance to type one.
   */
  const [attempted, setAttempted] = useState(false);
  const price = calculatePrice(values.applianceCount, product.id);
  const showTenantFields =
    values.customerType === "landlord" || values.customerType === "letting-agent";

  function set<K extends keyof DetailsValues>(key: K, value: DetailsValues[K]) {
    onPatch({ [key]: value } as Partial<DetailsValues>);
  }

  /**
   * Everything wrong with the form right now.
   *
   * `addressReady` is the postcode's own verdict — it is only true once the
   * postcode has been looked up and found to be inside the service area, which
   * this module cannot determine on its own.
   */
  function currentErrors(): DetailsErrors {
    const errors = validateDetails({
      ...values,
      tenantPhone: values.tenantPhone,
      appliancePricing: product.appliancePricing,
    });
    if (!errors.postcode && !addressReady) {
      errors.postcode =
        "Check your postcode so we can confirm the property is in our area.";
    }
    return errors;
  }

  /**
   * Live once a submit has been attempted, so a message disappears as soon as
   * the field is put right rather than lingering until the next press.
   * Server-side field errors show underneath until the customer edits.
   */
  const liveErrors = attempted ? currentErrors() : {};
  const shownErrors: Record<string, string> = { ...fieldErrors, ...liveErrors };

  function handleSubmit() {
    setAttempted(true);
    const errors = currentErrors();

    if (hasErrors(errors)) {
      // Stay on this step, and send the customer to the first thing to fix.
      const field = firstInvalidField(errors);
      if (field) {
        const el = document.getElementById(field);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        (el as HTMLElement | null)?.focus({ preventScroll: true });
      }
      return;
    }

    onContinue();
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      aria-labelledby="your-details"
    >
      <h2 id="your-details" className="text-xl font-extrabold text-navy-900">
        Your details
      </h2>
      <p className="mt-1 text-sm text-navy-600">
        Only what we need to do the job and reach you on the day.
      </p>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="fullName" className={labelClass}>
            Full name
          </label>
          <input
            id="fullName"
            name="name"
            autoComplete="name"
            required
            value={values.fullName}
            onChange={(event) => set("fullName", event.target.value)}
            className={fieldClass}
          />
          <FieldError message={shownErrors.fullName} />
        </div>

        <div>
          <label htmlFor="email" className={labelClass}>
            Email address
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={values.email}
            onChange={(event) => set("email", event.target.value)}
            className={fieldClass}
          />
          <FieldError message={shownErrors.email} />
        </div>

        <PhoneField
          id="phone"
          label="Mobile number"
          value={values.phone}
          serverError={shownErrors.phone}
          hint="So the engineer can reach you on the day."
          onChange={(value) => set("phone", value)}
        />

        <AddressFields
          values={{
            houseOrName: values.houseOrName,
            street: values.street,
            town: values.town,
            postcode: values.postcode,
          }}
          fieldErrors={shownErrors}
          onPatch={onPatch}
          onReadyChange={setAddressReady}
        />

        <div>
          <label htmlFor="customerType" className={labelClass}>
            You are the
          </label>
          <select
            id="customerType"
            value={values.customerType}
            onChange={(event) =>
              set("customerType", event.target.value as DetailsValues["customerType"])
            }
            className={fieldClass}
          >
            {customerTypes.map((type) => (
              <option key={type} value={type}>
                {customerTypeLabels[type]}
              </option>
            ))}
          </select>
          <FieldError message={shownErrors.customerType} />
        </div>

        {/*
          Only asked where the answer changes something. A standalone boiler
          service is one boiler at a fixed price, so counting the hob and the
          gas fire would be asking a landlord for information nobody uses and
          implying a surcharge that does not exist. Everything else on this
          form — contact, address, customer type, tenant access — is needed for
          any visit, so nothing else is conditional.

          The server does not depend on this: `calculatePrice` refuses to add
          an appliance charge to a product without appliance pricing, whatever
          count arrives.
        */}
        {product.appliancePricing && (
        <div className="sm:col-span-2">
          <label htmlFor="applianceCount" className={labelClass}>
            How many gas appliances?
          </label>
          <select
            id="applianceCount"
            value={values.applianceCount}
            onChange={(event) => set("applianceCount", Number(event.target.value))}
            className={fieldClass}
          >
            {Array.from({ length: MAX_APPLIANCES }, (_, index) => index + 1).map(
              (count) => (
                <option key={count} value={count}>
                  {count} {count === 1 ? "appliance" : "appliances"}
                </option>
              ),
            )}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-navy-600">
            Count the boiler plus anything else that runs on gas — hob, oven,
            fire or water heater. {product.priceDisplay} covers{" "}
            {product.includes}; each extra one is{" "}
            {product.extraApplianceDisplay}.
          </p>
          <p className="mt-2 rounded-lg bg-navy-50 px-3 py-2 text-sm font-bold text-navy-900">
            Your price: £{price.total} total
            {price.extraCharge > 0 && (
              <span className="font-semibold text-navy-700">
                {" "}
                (£{price.basePrice} + £{price.extraCharge} for{" "}
                {price.extraAppliances} extra)
              </span>
            )}
          </p>
          <FieldError message={shownErrors.applianceCount} />
        </div>
        )}

        {!product.appliancePricing && (
          <div className="sm:col-span-2">
            <p className="rounded-lg bg-navy-50 px-3 py-2 text-sm font-bold text-navy-900">
              Your price: {product.priceTotalDisplay}
            </p>
          </div>
        )}

        {showTenantFields && (
          <>
            <div>
              <label htmlFor="tenantName" className={labelClass}>
                Tenant name{" "}
                <span className="font-medium text-navy-500">(optional)</span>
              </label>
              <input
                id="tenantName"
                value={values.tenantName}
                onChange={(event) => set("tenantName", event.target.value)}
                className={fieldClass}
              />
            </div>
            <PhoneField
              id="tenantPhone"
              label="Tenant phone"
              optional
              value={values.tenantPhone}
              serverError={shownErrors.tenantPhone}
              hint="So we can arrange access directly with them."
              onChange={(value) => set("tenantPhone", value)}
            />
          </>
        )}

        <div className="sm:col-span-2">
          <label htmlFor="accessNotes" className={labelClass}>
            Parking or access notes{" "}
            <span className="font-medium text-navy-500">(optional)</span>
          </label>
          <textarea
            id="accessNotes"
            rows={3}
            value={values.accessNotes}
            onChange={(event) => set("accessNotes", event.target.value)}
            placeholder="Permit parking, key safe, gate code, where the boiler is…"
            className={fieldClass}
          />
        </div>
      </div>

      {/* Honeypot. Hidden from people, tempting to bots. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 overflow-hidden">
        <label htmlFor="company">Company</label>
        <input
          id="company"
          tabIndex={-1}
          autoComplete="off"
          value={values.company}
          onChange={(event) => set("company", event.target.value)}
        />
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse">
        {/*
          Deliberately not disabled. A greyed-out button with no explanation is
          how the original defect hid: it gated on the address alone, so with a
          valid postcode it looked ready while the contact fields were empty.
          Pressing it now says exactly what is missing.
        */}
        <button
          type="submit"
          className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600 sm:flex-1"
        >
          Review booking
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border-2 border-navy-200 px-8 py-4 text-base font-bold text-navy-900 hover:border-navy-600"
        >
          Back
        </button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-navy-600">
        We use these details to carry out and arrange your appointment. See our{" "}
        <a
          href="/privacy"
          className="font-semibold text-flame-600 underline underline-offset-4"
        >
          privacy policy
        </a>
        .
      </p>
    </form>
  );
}
