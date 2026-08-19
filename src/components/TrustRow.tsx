import { business, cp12 } from "@/lib/business";

/**
 * Only verified facts from docs/business-details.md appear here.
 * There are no customer reviews yet, so no ratings are shown anywhere.
 */
const trustPoints = [
  {
    title: "Gas Safe Registered",
    detail: `Register No. ${business.gasSafeNumber}`,
  },
  {
    title: `${business.yearsExperience} Years' Experience`,
    detail: "In the gas industry",
  },
  {
    title: "Fully Insured",
    detail: "Family-run business",
  },
  {
    title: "Pay After Completion",
    detail: `Fixed ${cp12.priceDisplay} price`,
  },
];

export function TrustRow() {
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {trustPoints.map((point) => (
        <li
          key={point.title}
          className="rounded-xl border border-navy-100 bg-white px-4 py-3 text-center shadow-sm"
        >
          <p className="text-sm font-bold text-navy-900">{point.title}</p>
          <p className="mt-0.5 text-xs text-navy-600">{point.detail}</p>
        </li>
      ))}
    </ul>
  );
}
