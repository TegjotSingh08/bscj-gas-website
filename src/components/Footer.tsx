import Link from "next/link";
import {
  availability,
  business,
  serviceAreaCopy,
  serviceAreas,
} from "@/lib/business";

export function Footer() {
  return (
    <footer className="mt-20 border-t border-navy-100 bg-navy-900 text-navy-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-lg font-extrabold text-white">
            BSCJ <span className="text-flame-400">Gas &amp; Heating</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-navy-200">
            Family-run, Gas Safe registered gas engineers serving Wolverhampton
            and the surrounding area.
          </p>
          <p className="mt-4 text-sm text-navy-200">
            <span className="font-bold text-white">Gas Safe Registered</span>
            <br />
            <a
              href="https://www.gassaferegister.co.uk"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-flame-400"
            >
              Verify us on the Gas Safe Register
            </a>
          </p>
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-white">
            Contact
          </h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <a href={business.phoneHref} className="inline-flex min-h-11 items-center hover:text-flame-400">
                {business.phoneDisplay}
              </a>
            </li>
            <li>
              <a
                href={business.whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center hover:text-flame-400"
              >
                WhatsApp us
              </a>
            </li>
            <li>
              <a
                href={`mailto:${business.emailGeneral}`}
                className="inline-flex min-h-11 items-center hover:text-flame-400"
              >
                {business.emailGeneral}
              </a>
            </li>
            <li className="pt-2 text-navy-200">
              {availability.workingDays}
              <br />
              {availability.workingHours}
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-white">
            Areas Covered
          </h2>
          <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-navy-200">
            {serviceAreas.map((area) => (
              <li key={area}>{area}</li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-navy-300">
            {serviceAreaCopy.postcodeNote}
          </p>
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-white">
            Site
          </h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <Link href="/gas-safety-certificate-wolverhampton" className="inline-flex min-h-11 items-center hover:text-flame-400">
                Gas Safety Certificate
              </Link>
            </li>
            <li>
              <Link href="/book" className="inline-flex min-h-11 items-center hover:text-flame-400">Book Online</Link>
            </li>
            <li>
              <Link href="/about" className="inline-flex min-h-11 items-center hover:text-flame-400">About</Link>
            </li>
            <li>
              <Link href="/contact" className="inline-flex min-h-11 items-center hover:text-flame-400">Contact</Link>
            </li>
            <li>
              <Link href="/privacy" className="inline-flex min-h-11 items-center hover:text-flame-400">Privacy Policy</Link>
            </li>
            <li>
              <Link href="/terms" className="inline-flex min-h-11 items-center hover:text-flame-400">Terms</Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-navy-800">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-navy-200">
          <p>
            {business.name} is a trading name of {business.legalName}. Gas Safe
            Register No. {business.gasSafeNumber}.
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} {business.legalName}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
