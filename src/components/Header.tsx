"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { business } from "@/lib/business";

/**
 * Site header.
 *
 * Desktop keeps a conventional horizontal navigation. Mobile gets a single
 * compact row and a disclosure menu.
 *
 * The mobile navigation used to be a horizontally scrolling strip of pills.
 * Measured at 320px it was 462px wide inside a 320px viewport — 142px hidden,
 * with About and Contact entirely off-screen — and it pushed the header to
 * 126px, 22% of the viewport, before any page content. Sideways scrolling is
 * not a discoverable way to reach a navigation item, so it is gone.
 *
 * A disclosure rather than a modal dialog: no focus trap to get wrong, no
 * scroll locking, and the links stay in the DOM for crawlers.
 */

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/book", label: "Book online" },
  {
    href: "/gas-safety-certificate-wolverhampton",
    label: "Gas safety certificates",
    short: "CP12",
  },
  { href: "/#areas", label: "Areas we cover" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/terms", label: "Terms" },
];

/** Desktop shows the four that earn the space. */
const desktopLinks = navLinks.filter((link) =>
  ["/gas-safety-certificate-wolverhampton", "/book", "/about", "/contact"].includes(
    link.href,
  ),
);

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    >
      {open ? (
        <>
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </>
      ) : (
        <>
          <path d="M3.5 7h17" />
          <path d="M3.5 12h17" />
          <path d="M3.5 17h17" />
        </>
      )}
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="currentColor"
    >
      <path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
    </svg>
  );
}

export function Header() {
  const pathname = usePathname();
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Open state is remembered against the path it was opened on, so navigating
   * closes the menu without an effect that reaches back into state — browser
   * back and forward included.
   */
  const [menu, setMenu] = useState({ open: false, path: pathname });
  const open = menu.open && menu.path === pathname;
  const setOpen = (value: boolean) => setMenu({ open: value, path: pathname });

  useEffect(() => {
    if (!open) return;

    // `setMenu` is the stable setter from useState, so this effect depends on
    // nothing but `open`.
    const close = () => setMenu((current) => ({ ...current, open: false }));

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      close();
      // Escape should leave focus somewhere sensible, not nowhere.
      toggleRef.current?.focus();
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      close();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  /**
   * The hash is dropped first, so "/#areas" is judged as "/" rather than
   * matching every path via startsWith — which had it marked as the current
   * page everywhere on the site.
   */
  const isCurrent = (href: string) => {
    const path = href.split("#")[0] || "/";
    return path === "/" ? pathname === "/" : pathname.startsWith(path);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-navy-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-2.5 sm:py-3">
        <Link href="/" className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-base font-extrabold tracking-tight text-navy-900 sm:text-lg">
            BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
          </span>
          {/*
            "· Wolverhampton" only once there is room for it. At 320px the full
            line truncated to "Gas Safe Registered · Wolv…", which reads worse
            than simply not saying it.
          */}
          <span className="text-[11px] font-medium text-navy-600 sm:text-xs">
            Gas Safe Registered
            <span className="hidden min-[380px]:inline"> · Wolverhampton</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
          {desktopLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isCurrent(link.href) ? "page" : undefined}
              className="text-sm font-semibold text-navy-700 hover:text-flame-600 aria-[current=page]:text-flame-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href={business.phoneHref}
            data-analytics-id="header-call"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-navy-800 px-3 text-sm font-bold text-white hover:bg-navy-900 sm:px-4"
          >
            <PhoneIcon />
            <span className="sm:hidden">Call</span>
            <span className="hidden sm:inline">{business.phoneDisplay}</span>
          </a>

          <button
            ref={toggleRef}
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? "Close menu" : "Open menu"}
            data-analytics-id="header-menu"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border-2 border-navy-200 text-navy-900 hover:border-navy-600 md:hidden"
          >
            <MenuIcon open={open} />
          </button>
        </div>
      </div>

      {/*
        Kept in the DOM and hidden with `hidden` rather than unmounted, so the
        links remain crawlable and the toggle has something to control.
      */}
      <div
        ref={panelRef}
        id={menuId}
        hidden={!open}
        className="border-t border-navy-100 bg-white md:hidden"
      >
        <nav aria-label="Mobile" className="mx-auto max-w-6xl px-4 py-2">
          <ul>
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  aria-current={isCurrent(link.href) ? "page" : undefined}
                  className="flex min-h-12 items-center border-b border-navy-100 text-base font-bold text-navy-800 last:border-0 aria-[current=page]:text-flame-600"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
