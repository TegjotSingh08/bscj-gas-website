import Link from "next/link";
import { business } from "@/lib/business";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-24 text-center">
      <p className="text-sm font-bold uppercase tracking-wider text-flame-600">
        404
      </p>
      <h1 className="mt-3 text-4xl font-extrabold text-navy-900">
        We could not find that page
      </h1>
      <p className="mt-4 text-base leading-relaxed text-navy-700">
        It may have moved. You can book a gas safety certificate below, or just
        give us a ring.
      </p>
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <Link
          href="/book"
          className="rounded-xl bg-flame-500 px-8 py-4 text-base font-bold text-white hover:bg-flame-600"
        >
          Book online
        </Link>
        <a
          href={business.phoneHref}
          className="rounded-xl border-2 border-navy-200 px-8 py-4 text-base font-bold text-navy-900 hover:border-navy-600"
        >
          Call {business.phoneDisplay}
        </a>
      </div>
    </section>
  );
}
