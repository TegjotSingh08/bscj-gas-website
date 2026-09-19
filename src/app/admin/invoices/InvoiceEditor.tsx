"use client";

import { useActionState, useState } from "react";

import { saveDraftAction, type ActionState } from "./actions";
import {
  formatPence,
  MAX_LINES,
  penceToPounds,
  poundsToPence,
} from "@/lib/invoices/model";
import type { EligiblePayer, InvoiceLineRow } from "@/lib/invoices/invoices";

/**
 * Editing a draft.
 *
 * The running total on screen is a **convenience, not the figure**. It is
 * recomputed from the inputs as they are typed so an administrator can see
 * what they are doing, and it is thrown away on submit: the server recalculates
 * every line and every total from the description, the quantity and the unit
 * price, and nothing this component computes is posted.
 *
 * Three things on this form were deliberate:
 *
 * 1. **The payer is a choice, not an assumption.** The job's billing customer
 *    is preselected and the alternatives are the two or three customers
 *    actually related to the job. There is no free-text payer and no search
 *    over every customer, because neither has a relationship to justify it.
 * 2. **The billing address is typed, and it is not the property.** The label
 *    says so. Missing it blocks issuing rather than falling back to the
 *    address the work happened at.
 * 3. **The quoted price is shown beside the total**, with the difference,
 *    whenever they disagree. An adjustment should be a thing somebody
 *    decided, not a thing somebody discovers.
 */

const field =
  "mt-1 w-full rounded-xl border-2 border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-900 focus:border-flame-500";

type EditableLine = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
};

function toEditable(lines: InvoiceLineRow[]): EditableLine[] {
  if (lines.length === 0) {
    return [{ key: "new-0", description: "", quantity: "1", unitPrice: "" }];
  }
  return lines.map((line, index) => ({
    key: line.id || `row-${index}`,
    description: line.description,
    quantity: String(line.quantity),
    unitPrice: penceToPounds(line.unitPricePence),
  }));
}

/** The line total as the browser can work it out. Never posted. */
function previewTotal(line: EditableLine): number | null {
  const quantity = Number(line.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  const price = poundsToPence(line.unitPrice);
  if (!price.ok) return null;
  return quantity * price.pence;
}

export function InvoiceEditor({
  invoiceId,
  lines: initialLines,
  payers,
  payerId,
  billingAddress,
  billingPostcode,
  quotedTotalPence,
}: {
  invoiceId: string;
  lines: InvoiceLineRow[];
  payers: EligiblePayer[];
  payerId: string;
  billingAddress: string;
  billingPostcode: string;
  quotedTotalPence: number | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveDraftAction,
    {},
  );
  const [lines, setLines] = useState<EditableLine[]>(toEditable(initialLines));

  const errors = state.errors ?? {};

  const runningTotal = lines.reduce(
    (sum, line) => sum + (previewTotal(line) ?? 0),
    0,
  );
  const difference =
    quotedTotalPence === null ? null : runningTotal - quotedTotalPence;

  const update = (index: number, patch: Partial<EditableLine>) => {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  };

  return (
    <form action={action} className="mt-4 grid gap-5">
      <input type="hidden" name="invoiceId" value={invoiceId} />

      {state.error && (
        <p
          role="alert"
          className="rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.error}
        </p>
      )}
      {state.message && (
        <p
          role="status"
          className="rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      {/* -- Payer ------------------------------------------------------- */}
      <fieldset className="rounded-2xl border-2 border-navy-200 p-4">
        <legend className="px-2 text-xs font-bold uppercase tracking-wide text-navy-600">
          Who is being billed
        </legend>

        <label
          htmlFor="payerId"
          className="block text-xs font-bold uppercase tracking-wide text-navy-600"
        >
          Payer
        </label>
        <select id="payerId" name="payerId" defaultValue={payerId} className={field}>
          {payers.map((payer) => (
            <option key={payer.id} value={payer.id}>
              {payer.company ? `${payer.company} — ${payer.name}` : payer.name} (
              {payer.relationship})
            </option>
          ))}
        </select>
        {errors.payerId ? (
          <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
            {errors.payerId}
          </p>
        ) : (
          <p className="mt-1 text-xs text-navy-600">
            Starts as whoever the job says is billed. Changing it here changes
            this invoice only — the job&rsquo;s billing stays as it is.
          </p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="billingAddress"
              className="block text-xs font-bold uppercase tracking-wide text-navy-600"
            >
              Billing address
            </label>
            <textarea
              id="billingAddress"
              name="billingAddress"
              rows={3}
              defaultValue={billingAddress}
              placeholder={"Suite 4\n12 Example Street\nWolverhampton"}
              className={field}
            />
            {errors.billingAddress ? (
              <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
                {errors.billingAddress}
              </p>
            ) : (
              <p className="mt-1 text-xs text-navy-600">
                Where the bill goes. <strong>Not</strong> the property the work
                was done at — that is printed in the table below on its own.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="billingPostcode"
              className="block text-xs font-bold uppercase tracking-wide text-navy-600"
            >
              Billing postcode
            </label>
            <input
              id="billingPostcode"
              name="billingPostcode"
              defaultValue={billingPostcode}
              className={field}
            />
            {errors.billingPostcode && (
              <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
                {errors.billingPostcode}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      {/* -- Lines ------------------------------------------------------- */}
      <fieldset className="rounded-2xl border-2 border-navy-200 p-4">
        <legend className="px-2 text-xs font-bold uppercase tracking-wide text-navy-600">
          What is being charged
        </legend>

        {errors.lines && (
          <p role="alert" className="mb-3 text-xs font-bold text-flame-600">
            {errors.lines}
          </p>
        )}

        <div className="grid gap-4">
          {lines.map((line, index) => {
            const total = previewTotal(line);
            return (
              <div
                key={line.key}
                className="grid gap-3 rounded-xl bg-navy-50 p-3 sm:grid-cols-[1fr_5rem_7rem_6rem]"
              >
                <div>
                  <label
                    htmlFor={`line-${index}-description`}
                    className="block text-xs font-bold uppercase tracking-wide text-navy-600"
                  >
                    Description
                  </label>
                  <input
                    id={`line-${index}-description`}
                    name={`line-${index}-description`}
                    value={line.description}
                    onChange={(e) => update(index, { description: e.target.value })}
                    className={field}
                  />
                  {errors[`line-${index}-description`] && (
                    <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
                      {errors[`line-${index}-description`]}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor={`line-${index}-quantity`}
                    className="block text-xs font-bold uppercase tracking-wide text-navy-600"
                  >
                    Qty
                  </label>
                  <input
                    id={`line-${index}-quantity`}
                    name={`line-${index}-quantity`}
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={(e) => update(index, { quantity: e.target.value })}
                    className={field}
                  />
                  {errors[`line-${index}-quantity`] && (
                    <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
                      {errors[`line-${index}-quantity`]}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor={`line-${index}-unitPrice`}
                    className="block text-xs font-bold uppercase tracking-wide text-navy-600"
                  >
                    Unit £
                  </label>
                  <input
                    id={`line-${index}-unitPrice`}
                    name={`line-${index}-unitPrice`}
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(e) => update(index, { unitPrice: e.target.value })}
                    className={field}
                  />
                  {errors[`line-${index}-unitPrice`] && (
                    <p role="alert" className="mt-1 text-xs font-bold text-flame-600">
                      {errors[`line-${index}-unitPrice`]}
                    </p>
                  )}
                </div>

                <div className="flex flex-col justify-end pb-1">
                  <p
                    className="text-right text-sm font-extrabold text-navy-900"
                    data-testid={`line-${index}-total`}
                  >
                    {total === null ? "—" : formatPence(total)}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setLines((current) => current.filter((_, i) => i !== index))
                    }
                    className="mt-1 text-right text-xs font-bold text-flame-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {lines.length < MAX_LINES && (
          <button
            type="button"
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  key: `new-${Date.now()}`,
                  description: "",
                  quantity: "1",
                  unitPrice: "",
                },
              ])
            }
            className="mt-3 rounded-xl border-2 border-navy-200 px-4 py-2 text-sm font-bold text-navy-900 hover:border-flame-500"
          >
            Add a line
          </button>
        )}

        {/* The comparison with what the job was quoted. */}
        <div className="mt-4 border-t-2 border-navy-100 pt-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-navy-600">Invoice total</span>
            <span
              className="text-lg font-extrabold text-navy-900"
              data-testid="running-total"
            >
              {formatPence(runningTotal)}
            </span>
          </div>
          {quotedTotalPence !== null && (
            <div className="mt-1 flex items-baseline justify-between text-xs">
              <span className="text-navy-600">
                Job was quoted {formatPence(quotedTotalPence)}
              </span>
              {difference !== null && difference !== 0 && (
                <span
                  className="font-bold text-flame-600"
                  data-testid="quote-difference"
                >
                  {difference > 0 ? "+" : ""}
                  {formatPence(difference)} against the quote
                </span>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-navy-600">
            Every figure is recalculated on the server when this is saved. The
            job&rsquo;s own price is never changed by an invoice.
          </p>
        </div>
      </fieldset>

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save draft"}
        </button>
      </div>
    </form>
  );
}
