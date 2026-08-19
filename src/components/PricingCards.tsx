import Link from "next/link";
import { cp12 } from "@/lib/business";

/** Derived from the CP12 price and extra-appliance rate — never hardcoded. */
const priceTiers = [
  { label: `Boiler + up to 2 appliances`, total: cp12.price },
  { label: `Boiler + 3 appliances`, total: cp12.price + cp12.extraAppliancePrice },
  { label: `Boiler + 4 appliances`, total: cp12.price + cp12.extraAppliancePrice * 2 },
];

export function PricingCards() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-2xl border-2 border-flame-500 bg-white p-7 shadow-lg">
        <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
          Fixed price
        </p>
        <h3 className="mt-2 text-xl font-extrabold text-navy-900">
          Gas Safety Certificate (CP12)
        </h3>
        <p className="mt-4 flex items-baseline gap-2">
          <span className="text-5xl font-extrabold text-navy-900">
            {cp12.priceDisplay}
          </span>
          <span className="text-sm font-medium text-navy-600">
            {cp12.totalNote} · paid after completion
          </span>
        </p>

        <ul className="mt-6 space-y-2.5 text-sm text-navy-800">
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            Covers {cp12.includes}
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            Full safety check by a Gas Safe registered engineer
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            Physical certificate completed at your property
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            Digital copy emailed the same day, free of charge
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            Typically takes about {cp12.durationMinutes} minutes
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            {cp12.payment} — nothing to pay upfront
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-trust-600">✓</span>
            No account to create and no deposit — booking takes about a minute
          </li>
        </ul>

        <Link
          href="/book"
          data-analytics-id="pricing-book"
          className="mt-7 block rounded-xl bg-flame-500 px-6 py-4 text-center text-base font-bold text-white hover:bg-flame-600"
        >
          Book your CP12
        </Link>
      </div>

      <div className="rounded-2xl border border-navy-100 bg-navy-50 p-7">
        <h3 className="text-xl font-extrabold text-navy-900">
          Got more appliances?
        </h3>
        <p className="mt-4 text-sm leading-relaxed text-navy-800">
          The {cp12.priceDisplay} price covers {cp12.includes}. If your property
          has more than that, each additional appliance is{" "}
          <span className="font-bold">{cp12.extraApplianceDisplay}</span>.
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
      </div>
    </div>
  );
}
