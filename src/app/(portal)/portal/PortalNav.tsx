import Link from "next/link";

import { SignOutButton } from "./SignOutButton";

/**
 * The portal header.
 *
 * A server component: it renders what `requireAgent()` already resolved rather
 * than fetching anything of its own, so no page pays for it twice.
 */
export function PortalNav({
  organisationName,
  userName,
  current,
}: {
  organisationName: string;
  userName: string;
  current: "dashboard" | "portfolio" | "landlords";
}) {
  const links = [
    { href: "/portal", label: "Dashboard", key: "dashboard" },
    { href: "/portal/portfolio", label: "Portfolio", key: "portfolio" },
    { href: "/portal/landlords", label: "Landlords", key: "landlords" },
  ] as const;

  return (
    <header className="border-b-2 border-navy-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            BSCJ Gas &amp; Heating
          </p>
          <p className="text-lg font-extrabold text-navy-900">
            {organisationName}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-navy-600 sm:inline">
            {userName}
          </span>
          <SignOutButton />
        </div>
      </div>
      <nav className="mx-auto max-w-6xl px-4">
        <ul className="flex gap-1 overflow-x-auto">
          {links.map((link) => (
            <li key={link.key}>
              <Link
                href={link.href}
                aria-current={current === link.key ? "page" : undefined}
                className={
                  current === link.key
                    ? "inline-block border-b-4 border-flame-500 px-4 py-3 text-sm font-bold text-navy-900"
                    : "inline-block border-b-4 border-transparent px-4 py-3 text-sm font-bold text-navy-600 hover:text-navy-900"
                }
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
