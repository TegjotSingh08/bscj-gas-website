import { serviceAreas } from "@/lib/business";

export function AreasCovered() {
  return (
    <div>
      <ul className="flex flex-wrap justify-center gap-3">
        {serviceAreas.map((area) => (
          <li
            key={area}
            className="rounded-full border border-navy-200 bg-white px-5 py-2 text-sm font-semibold text-navy-800"
          >
            {area}
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-6 max-w-xl text-center text-sm text-navy-600">
        Just outside these areas? Call or WhatsApp us and we will let you know
        if we can get to you.
      </p>
    </div>
  );
}
