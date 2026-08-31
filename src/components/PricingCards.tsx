import Link from "next/link";
import { cp12, inspectionScope } from "@/lib/business";
import { bundleSavingFor, products } from "@/lib/booking/products";

/** Derived from the CP12 price and extra-appliance rate — never hardcoded. */
const priceTiers = [
  { label: `Boiler + up to 2 appliances`, total: cp12.price },
  { label: `Boiler + 3 appliances`, total: cp12.price + cp12.extraAppliancePrice },
  { label: `Boiler + 4 appliances`, total: cp12.price + cp12.extraAppliancePrice * 2 },
];

const tick = (
  <span aria-hidden="true" className="text-trust-600">
    ✓
  </span>
);

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 space-y-2 text-sm text-navy-800">
      {items.map((point) => (
        <li key={point} className="flex gap-2">
          {tick}
          {point}
        </li>
      ))}
    </ul>
  );
}

/**
 * The three prices, side by side.
 *
 * Every card is built the same way — eyebrow, name, price, one line of
 * difference, then detail — so the three figures line up and can be compared
 * at a glance without reading. The prices are the largest thing on the page
 * after the headings.
 *
 * The CP12 keeps the accent border as the entry offer; the bundle carries the
 * saving. Nothing about what the boiler service *includes* appears on any of
 * them, because that has never been specified.
 */
export function PricingCards() {
  const certificate = products.cp12;
  const service = products["boiler-service"];
  const bundle = products["cp12-boiler-service"];
  const saving = bundleSavingFor(bundle.id);

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-3">
        {/* 1 — the entry offer, and the one the hero sends people here for. */}
        <div className="flex flex-col rounded-2xl border-2 border-flame-500 bg-white p-6 shadow-lg">
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            Fixed price
          </p>
          <h3 className="mt-2 text-lg font-extrabold text-navy-900">
            {certificate.name}
          </h3>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-5xl font-extrabold leading-none tracking-tight text-navy-900">
              {certificate.priceDisplay}
            </span>
            <span className="text-sm font-medium text-navy-600">
              {cp12.totalNote}
            </span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-navy-700">
            {certificate.tagline}
          </p>
          <Points
            items={[
              `Covers ${certificate.includes}`,
              "Full safety check by a Gas Safe registered engineer",
              "No separate CP12 call-out charge",
              "Physical certificate completed at your property",
              "Digital copy emailed the same day, free of charge",
              `Typically takes about ${certificate.durationMinutes} minutes`,
              `${cp12.payment} — nothing to pay upfront`,
            ]}
          />
          <Link
            href="/book"
            data-analytics-id="pricing-book"
            className="mt-6 block rounded-xl bg-flame-500 px-6 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
          >
            Book CP12 — {certificate.priceDisplay}
          </Link>
        </div>

        {/* 2 — the standalone service. Deliberately says only what is known. */}
        <div className="flex flex-col rounded-2xl border border-navy-200 bg-white p-6">
          <p className="text-xs font-bold uppercase tracking-wider text-navy-600">
            Also available
          </p>
          <h3 className="mt-2 text-lg font-extrabold text-navy-900">
            {service.name}
          </h3>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-5xl font-extrabold leading-none tracking-tight text-navy-900">
              {service.priceDisplay}
            </span>
            <span className="text-sm font-medium text-navy-600">
              {cp12.totalNote}
            </span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-navy-700">
            {service.tagline}
          </p>
          <Points
            items={[
              "Your annual boiler service, booked on its own",
              "Carried out by a Gas Safe registered engineer",
              "A fixed price, whatever else runs on gas in the property",
              "No separate call-out charge",
              `${cp12.payment} — nothing to pay upfront`,
            ]}
          />
          <Link
            href="/book"
            data-analytics-id="pricing-book-service"
            className="mt-6 block rounded-xl border-2 border-navy-900 px-6 py-4 text-center text-base font-bold text-navy-900 hover:bg-navy-900 hover:text-white"
          >
            Book a service — {service.priceDisplay}
          </Link>
        </div>

        {/* 3 — the bundle, carrying a saving that is arithmetic on the two above. */}
        <div className="flex flex-col rounded-2xl border-2 border-navy-900 bg-white p-6">
          <p className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-navy-900 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
              Best value
            </span>
            {saving && (
              <span className="text-xs font-bold uppercase tracking-wider text-trust-600">
                Save {saving.savingDisplay}
              </span>
            )}
          </p>
          <h3 className="mt-2 text-lg font-extrabold text-navy-900">
            {bundle.name}
          </h3>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-5xl font-extrabold leading-none tracking-tight text-navy-900">
              {bundle.priceDisplay}
            </span>
            <span className="text-sm font-medium text-navy-600">
              {cp12.totalNote}
            </span>
          </p>
          {saving && (
            /*
              Both halves of this comparison are published, bookable prices —
              £45 and £60 — so it is arithmetic, not a crossed-out invention.
            */
            <p className="mt-2 text-sm font-bold text-navy-900">
              {saving.separateTotalDisplay} separately ·{" "}
              {bundle.priceDisplay} together
            </p>
          )}
          <p className="mt-3 text-sm leading-relaxed text-navy-700">
            Your annual gas safety check and boiler service, all in one visit.
          </p>
          <Points
            items={[
              `Save ${saving?.savingDisplay ?? ""} against booking them separately`,
              "Both jobs completed in the same appointment",
              `Covers ${bundle.includes} for the certificate`,
              "Helps keep your boiler running properly",
              `${cp12.payment} — nothing to pay upfront`,
            ]}
          />
          <Link
            href="/book"
            data-analytics-id="pricing-book-bundle"
            className="mt-6 block rounded-xl bg-navy-900 px-6 py-4 text-center text-base font-bold text-white hover:bg-navy-800"
          >
            Book CP12 + Service — {bundle.priceDisplay}
          </Link>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-navy-100 bg-navy-50 p-7">
        <h3 className="text-xl font-extrabold text-navy-900">
          Got more appliances?
        </h3>
        <p className="mt-4 text-sm leading-relaxed text-navy-800">
          The {cp12.priceDisplay} price covers {cp12.includes}. If your property
          has more than that, each additional appliance is{" "}
          <span className="font-bold">{cp12.extraApplianceDisplay}</span>. This
          applies to the services that include a gas safety certificate — the{" "}
          {service.name} is {service.priceTotalDisplay} whatever else runs on
          gas, because it covers your boiler.
        </p>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-navy-200 text-navy-600">
                <th scope="col" className="py-2 font-semibold">What you have</th>
                <th scope="col" className="py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="text-navy-900">
              {priceTiers.map((tier) => (
                <tr key={tier.label} className="border-b border-navy-100 last:border-0">
                  <td className="py-2.5">{tier.label}</td>
                  <td className="py-2.5 text-right font-bold">£{tier.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-5 text-xs leading-relaxed text-navy-600">
          {cp12.priceSentence}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-navy-600">
          Not sure how many appliances you have? An appliance is anything that
          runs on gas — a gas hob, gas oven, gas fire or gas water heater. Tell
          us when you book, or ask us and we will work it out with you.
        </p>

        {/*
          The inspection/repair distinction, made before booking rather than on
          the doorstep. Framed as what the price buys, not as a warning.
        */}
        <div className="mt-6 border-t border-navy-200 pt-5">
          <h4 className="text-sm font-bold text-navy-900">
            If the inspection finds a problem
          </h4>
          <p className="mt-2 text-xs leading-relaxed text-navy-700">
            {inspectionScope.chargeAppliesRegardless}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-navy-700">
            {inspectionScope.repairsExcluded} {inspectionScope.remedialOffer}
          </p>
          <p className="mt-2 text-xs font-semibold leading-relaxed text-navy-800">
            {inspectionScope.noObligation}
          </p>
        </div>
      </div>
    </>
  );
}
