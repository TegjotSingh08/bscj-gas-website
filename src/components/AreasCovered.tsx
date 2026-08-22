import { serviceAreaCopy, serviceAreas } from "@/lib/business";

/**
 * The towns listed are indicative, not a promise. Coverage is decided at
 * booking from the property's postcode, so the copy points at the postcode
 * check rather than letting a town name imply acceptance.
 */
export function AreasCovered() {
  return (
    <div>
      <p className="mx-auto max-w-2xl text-center text-base leading-relaxed text-navy-700">
        {serviceAreaCopy.headline} {serviceAreaCopy.radius}
      </p>

      <ul className="mt-6 flex flex-wrap justify-center gap-3">
        {serviceAreas.map((area) => (
          <li
            key={area}
            className="rounded-full border border-navy-200 bg-white px-5 py-2 text-sm font-semibold text-navy-800"
          >
            {area}
          </li>
        ))}
      </ul>

      <p className="mx-auto mt-6 max-w-xl text-center text-sm leading-relaxed text-navy-600">
        {serviceAreaCopy.postcodeNote} Just outside it? Call or WhatsApp us and
        we will let you know if we can get to you.
      </p>
    </div>
  );
}
