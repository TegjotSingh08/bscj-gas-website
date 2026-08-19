import { faqs } from "@/lib/faqs";

export function FAQ() {
  return (
    <div className="mx-auto max-w-3xl divide-y divide-navy-100 rounded-2xl border border-navy-100 bg-white">
      {faqs.map((faq) => (
        <details key={faq.question} className="group px-5 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-base font-bold text-navy-900 marker:hidden">
            {faq.question}
            <span
              aria-hidden="true"
              className="shrink-0 text-xl leading-none text-flame-600 transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-navy-800">
            {faq.answer}
          </p>
        </details>
      ))}
    </div>
  );
}
