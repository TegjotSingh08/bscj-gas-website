"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";

import { bookWorkAction, type ActionState } from "../../../jobs/actions";
import { Field, Notice, fieldClass, primaryClass } from "../../form-parts";

/**
 * Booking work against a property.
 *
 * One page. The agent has already opened the property, so the address, the
 * landlord and the tenant are shown as confirmation rather than re-entered —
 * the only decisions left are which service, how urgent, and how many
 * appliances.
 *
 * The price shown comes from the server. It is passed in as a quote per
 * service and per appliance count, resolved through the same code that will
 * write the job, so the figure on screen cannot drift from the figure stored.
 * Nothing here calculates a price, and the action would ignore one if it did.
 *
 * `submissionKey` is minted once when the form mounts and never changes, so a
 * double click sends the same key and the server recognises the second as a
 * retry of the first.
 */

export type Quote = {
  productId: string;
  name: string;
  tagline: string;
  /** Pence, by appliance count, resolved server-side. */
  byAppliances: Record<number, number>;
  appliancePricing: boolean;
  durationMinutes: number;
};

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;

export function BookWorkForm({
  propertyId,
  quotes,
  tenant,
  maxAppliances,
}: {
  propertyId: string;
  quotes: Quote[];
  tenant: { name: string | null; phone: string | null; email: string | null } | null;
  maxAppliances: number;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    bookWorkAction,
    {},
  );

  // Minted once per mounted form. A second click reuses it, which is what
  // makes the retry a retry rather than a second job.
  const submissionKey = useMemo(() => crypto.randomUUID(), []);

  const [productId, setProductId] = useState(quotes[0]?.productId ?? "cp12");
  const [applianceCount, setApplianceCount] = useState(1);
  const [timing, setTiming] = useState<"asap" | "deadline">("asap");

  const selected = quotes.find((quote) => quote.productId === productId);
  const price = selected?.byAppliances[applianceCount];

  return (
    <form action={action} className="mt-6 space-y-6">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="submissionKey" value={submissionKey} />

      {state.message && <Notice tone="error">{state.message}</Notice>}
      {state.errors?.form && <Notice tone="error">{state.errors.form}</Notice>}

      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Service</h2>
        <div className="mt-3 space-y-2">
          {quotes.map((quote) => (
            <label
              key={quote.productId}
              className={
                productId === quote.productId
                  ? "flex cursor-pointer items-start gap-3 rounded-xl border-2 border-flame-500 bg-flame-400/5 p-4"
                  : "flex cursor-pointer items-start gap-3 rounded-xl border-2 border-navy-200 p-4 hover:border-navy-400"
              }
            >
              <input
                type="radio"
                name="productId"
                value={quote.productId}
                checked={productId === quote.productId}
                onChange={() => setProductId(quote.productId)}
                className="mt-1"
              />
              <span className="flex-1">
                <span className="block text-sm font-bold text-navy-900">
                  {quote.name}
                </span>
                <span className="block text-xs text-navy-600">
                  {quote.tagline} · {quote.durationMinutes} minutes on site
                </span>
              </span>
              <span className="text-sm font-extrabold text-navy-900">
                {money(quote.byAppliances[applianceCount] ?? 0)}
              </span>
            </label>
          ))}
        </div>
        {state.errors?.productId && (
          <p className="mt-2 text-xs font-semibold text-flame-600">
            {state.errors.productId}
          </p>
        )}

        {selected?.appliancePricing && (
          <div className="mt-4 max-w-xs">
            <label
              htmlFor="applianceCount"
              className="block text-sm font-bold text-navy-900"
            >
              Gas appliances
            </label>
            <select
              id="applianceCount"
              name="applianceCount"
              value={applianceCount}
              onChange={(event) => setApplianceCount(Number(event.target.value))}
              className={fieldClass}
            >
              {Array.from({ length: maxAppliances }, (_, index) => index + 1).map(
                (count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ),
              )}
            </select>
            <p className="mt-1 text-xs text-navy-600">
              The certificate covers one boiler and two more. Anything beyond
              that is priced per appliance.
            </p>
          </div>
        )}
        {!selected?.appliancePricing && (
          // Sent regardless so the server has a value; the registry ignores it
          // for a service that is not priced by appliance.
          <input type="hidden" name="applianceCount" value={1} />
        )}
      </section>

      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">When</h2>
        <div className="mt-3 space-y-2">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-navy-900">
            <input
              type="radio"
              name="timing"
              value="asap"
              checked={timing === "asap"}
              onChange={() => setTiming("asap")}
            />
            As soon as possible
          </label>
          <label className="flex cursor-pointer items-center gap-3 text-sm text-navy-900">
            <input
              type="radio"
              name="timing"
              value="deadline"
              checked={timing === "deadline"}
              onChange={() => setTiming("deadline")}
            />
            By a particular date
          </label>
        </div>

        {timing === "deadline" && (
          <div className="mt-4 max-w-xs">
            <Field
              name="completeByDate"
              label="Complete by"
              type="date"
              required
              error={state.errors?.completeByDate}
            />
          </div>
        )}

        <p className="mt-3 rounded-xl bg-navy-50 px-4 py-3 text-xs leading-relaxed text-navy-700">
          {/*
            The scheduling boundary, stated plainly rather than implied. The
            agent is requesting work; the appointment is chosen later.
          */}
          We will arrange the appointment after this is submitted —{" "}
          {tenant?.phone || tenant?.email
            ? "your tenant will be invited to pick a time that suits them."
            : "we will contact you to arrange access, as there is no tenant on file."}{" "}
          Asking for a date is a request, not a confirmed appointment.
        </p>
      </section>

      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">
          Anything we should know?{" "}
          <span className="font-normal text-navy-600">— optional</span>
        </h2>
        <textarea
          name="notes"
          rows={2}
          placeholder="Access, the tenant's hours, a boiler that has been playing up…"
          className={fieldClass}
        />
      </section>

      <div className="rounded-2xl border-2 border-navy-900 bg-navy-900 p-5 text-white">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-bold">{selected?.name}</span>
          <span className="text-2xl font-extrabold">
            {price === undefined ? "—" : money(price)}
          </span>
        </div>
        <p className="mt-1 text-xs text-white/70">
          Your account price, calculated by us. Payment is after completion.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? "Submitting…" : "Book this work"}
        </button>
        <Link
          href={`/portal/portfolio/${propertyId}`}
          className="text-sm font-bold text-navy-600 underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
