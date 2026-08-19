"use client";

import { customerTypeLabels, customerTypes } from "@/lib/booking/schema";
import { calculatePrice, MAX_APPLIANCES } from "@/lib/booking/pricing";
import { cp12 } from "@/lib/business";

export type DetailsValues = {
  fullName: string;
  email: string;
  phone: string;
  propertyAddress: string;
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
  fieldErrors,
  onChange,
  onBack,
  onContinue,
}: {
  values: DetailsValues;
  fieldErrors: Record<string, string>;
  onChange: (values: DetailsValues) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const price = calculatePrice(values.applianceCount);
  const showTenantFields =
    values.customerType === "landlord" || values.customerType === "letting-agent";

  function set<K extends keyof DetailsValues>(key: K, value: DetailsValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
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
          <FieldError message={fieldErrors.fullName} />
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
          <FieldError message={fieldErrors.email} />
        </div>

        <div>
          <label htmlFor="phone" className={labelClass}>
            Mobile number
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={values.phone}
            onChange={(event) => set("phone", event.target.value)}
            className={fieldClass}
          />
          <FieldError message={fieldErrors.phone} />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="propertyAddress" className={labelClass}>
            Property address
          </label>
          <input
            id="propertyAddress"
            autoComplete="street-address"
            required
            placeholder="House number and street"
            value={values.propertyAddress}
            onChange={(event) => set("propertyAddress", event.target.value)}
            className={fieldClass}
          />
          <FieldError message={fieldErrors.propertyAddress} />
        </div>

        <div>
          <label htmlFor="postcode" className={labelClass}>
            Postcode
          </label>
          <input
            id="postcode"
            autoComplete="postal-code"
            required
            placeholder="WV1 1AA"
            value={values.postcode}
            onChange={(event) => set("postcode", event.target.value)}
            className={`${fieldClass} uppercase`}
          />
          <FieldError message={fieldErrors.postcode} />
        </div>

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
          <FieldError message={fieldErrors.customerType} />
        </div>

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
            fire or water heater. {cp12.priceDisplay} covers {cp12.includes};
            each extra one is {cp12.extraApplianceDisplay}.
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
          <FieldError message={fieldErrors.applianceCount} />
        </div>

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
            <div>
              <label htmlFor="tenantPhone" className={labelClass}>
                Tenant phone{" "}
                <span className="font-medium text-navy-500">(optional)</span>
              </label>
              <input
                id="tenantPhone"
                type="tel"
                inputMode="tel"
                value={values.tenantPhone}
                onChange={(event) => set("tenantPhone", event.target.value)}
                className={fieldClass}
              />
              <p className="mt-1 text-xs text-navy-600">
                So we can arrange access directly with them.
              </p>
            </div>
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
