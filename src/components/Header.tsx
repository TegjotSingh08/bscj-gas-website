import Link from "next/link";
import { business } from "@/lib/business";

const navLinks = [
  { href: "/gas-safety-certificate-wolverhampton", label: "Gas Safety Certificate" },
  { href: "/book", label: "Book Online" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-navy-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="flex flex-col leading-tight">
          <span className="text-lg font-extrabold tracking-tight text-navy-900">
            BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
          </span>
          <span className="text-[11px] font-medium text-navy-600">
            Gas Safe Registered {business.gasSafeNumber} · Wolverhampton
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-semibold text-navy-700 hover:text-flame-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <a
          href={business.phoneHref}
          className="hidden rounded-lg bg-navy-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-navy-900 sm:inline-block"
        >
          Call {business.phoneDisplay}
        </a>
      </div>
    </header>
  );
}
