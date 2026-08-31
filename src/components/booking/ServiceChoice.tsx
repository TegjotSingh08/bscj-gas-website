"use client";

import {
  bundleSavingFor,
  productList,
  type ProductId,
} from "@/lib/booking/products";

/**
 * The service the customer is booking.
 *
 * Deliberately not a fifth step: it sits above the step indicator, so choosing
 * a service costs nobody an extra tap on the way to a date.
 *
 * Rows rather than cards, now there are three. Three stacked cards would have
 * pushed the date picker off the first screen on a phone, which is the one
 * thing /book was measured and tuned to avoid. A row keeps each option to
 * about eighty pixels while leaving the price the largest thing on it: the
 * figure sits right-aligned at display size, the service name is a small label
 * and the single line of difference is quieter still.
 *
 * What the price covers is not repeated here. It is already on /book above the
 * flow, and again beside the appliance count on the details step, which is
 * where that question is actually being asked.
 *
 * The £45 is first and selected by default, and every price is set at the same
 * size — someone who came for a certificate must never feel they picked the
 * lesser thing.
 */
export function ServiceChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: ProductId;
  onChange: (productId: ProductId) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="disabled:opacity-60">
      <legend className="text-sm font-bold text-navy-900">
        Choose your service
      </legend>

      <div className="mt-2.5 flex flex-col gap-2">
        {productList.map((product) => {
          const selected = product.id === value;
          const saving = bundleSavingFor(product.id);

          return (
            <label
              key={product.id}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 px-3.5 py-3 transition-colors ${
                selected
                  ? "border-flame-500 bg-flame-400/10"
                  : "border-navy-200 bg-white hover:border-navy-400"
              }`}
            >
              <input
                type="radio"
                name="service"
                value={product.id}
                checked={selected}
                onChange={() => onChange(product.id)}
                data-analytics-id={`service-${product.id}`}
                className="h-5 w-5 shrink-0 border-2 border-navy-300"
              />

              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-bold uppercase leading-tight tracking-wider text-navy-600">
                  {product.name}
                </span>

                {/*
                  Stated only where it is true and only because both component
                  prices are themselves published and bookable — £45 and £60
                  against £90. It is arithmetic on real prices, not a claim.
                */}
                {saving && (
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-navy-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Best value
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-wide text-trust-600">
                      Save {saving.savingDisplay}
                    </span>
                  </span>
                )}

                <span className="mt-1 block text-xs leading-snug text-navy-600">
                  {product.tagline}
                </span>
              </span>

              {/* The dominant element on the row. */}
              <span className="shrink-0 text-right">
                <span className="block text-3xl font-extrabold leading-none tracking-tight text-navy-900">
                  {product.priceDisplay}
                </span>
                <span className="mt-0.5 block text-[11px] font-bold text-navy-600">
                  total
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
