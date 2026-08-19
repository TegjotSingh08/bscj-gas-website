import Link from "next/link";
import { business } from "@/lib/business";

const navLinks = [
  {
    href: "/gas-safety-certificate-wolverhampton",
    label: "Gas Safety Certificate",
    short: "CP12 Wolverhampton",
  },
  { href: "/book", label: "Book Online", short: "Book" },
  { href: "/about", label: "About", short: "About" },
  { href: "/contact", label: "Contact", short: "Contact" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-navy-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex flex-col leading-tight">
          <span className="text-base font-extrabold tracking-tight text-navy-900 sm:text-lg">
            BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
          </span>
          <span className="text-xs font-medium text-navy-600">
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
          data-analytics-id="header-call"
          className="shrink-0 rounded-lg bg-navy-800 px-3 py-2.5 text-sm font-bold text-white hover:bg-navy-900 sm:px-4"
        >
          <span className="sm:hidden">Call</span>
          <span className="hidden sm:inline">Call {business.phoneDisplay}</span>
        </a>
      </div>

      {/* Mobile navigation. A scrollable row rather than a hamburger: no
          JavaScript, nothing hidden behind a tap, and the links stay crawlable. */}
      <nav
        aria-label="Main"
        className="scrollbar-none flex gap-2 overflow-x-auto border-t border-navy-100 px-4 py-2 md:hidden"
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-navy-50 px-4 text-sm font-bold text-navy-700"
          >
            {link.short}
          </Link>
        ))}
      </nav>
    </header>
  );
}
