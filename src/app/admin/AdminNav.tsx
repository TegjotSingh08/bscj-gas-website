import Link from "next/link";

import { SignOutButton } from "./SignOutButton";

/**
 * The admin header.
 *
 * A server component: it renders what `requireAdmin()` has already resolved
 * rather than fetching anything of its own, so no page pays for it twice.
 *
 * It exists because the admin area had grown five pages that each invented
 * their own heading and their own way back — which is fine for one screen and
 * unusable for a tool somebody works in all day.
 */
export type AdminSection =
  | "dashboard"
  | "due"
  | "jobs"
  | "invoices"
  | "organisations"
  | "reconcile"
  | "settings"
  | "day";

export function AdminNav({
  userName,
  current,
}: {
  userName: string;
  current: AdminSection;
}) {
  const links = [
    { href: "/admin", label: "Dashboard", key: "dashboard" },
    { href: "/admin/due", label: "Renewals due", key: "due" },
    { href: "/admin/jobs", label: "Jobs", key: "jobs" },
    { href: "/admin/invoices", label: "Invoices", key: "invoices" },
    { href: "/admin/organisations", label: "Agencies", key: "organisations" },
    { href: "/admin/reconcile", label: "Reconciliation", key: "reconcile" },
    { href: "/engineer", label: "Engineer’s day", key: "day" },
    { href: "/admin/settings", label: "Business details", key: "settings" },
  ] as const;

  return (
    <header className="border-b-2 border-navy-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            BSCJ Gas &amp; Heating
          </p>
          <p className="text-lg font-extrabold text-navy-900">Admin</p>
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
                    ? "inline-block whitespace-nowrap border-b-4 border-flame-500 px-4 py-3 text-sm font-bold text-navy-900"
                    : "inline-block whitespace-nowrap border-b-4 border-transparent px-4 py-3 text-sm font-bold text-navy-600 hover:text-navy-900"
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
