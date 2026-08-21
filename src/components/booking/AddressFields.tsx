"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { business } from "@/lib/business";
import { looksLikePostcode, normalisePostcode } from "@/lib/address/format";

/**
 * Postcode-first property address entry.
 *
 * The postcode is validated against a real postcode database, which is the one
 * thing that can be checked hard and for free. It establishes that the
 * postcode is live, where it is, and whether the property is inside the area
 * we cover — but it says nothing about whether a house exists at it, and the
 * site never implies otherwise. The customer confirms the assembled address
 * themselves at the review step.
 */

export type AddressValues = {
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
};

type PostcodeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; postcode: string; areaName: string; covered: boolean }
  | { kind: "not_found" }
  | { kind: "malformed" }
  | { kind: "unavailable" };

const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-base text-navy-900 placeholder:text-navy-400 focus:border-flame-500 focus:outline-none";
const labelClass = "block text-sm font-bold text-navy-900";

export function AddressFields({
  values,
  fieldErrors,
  onPatch,
  onReadyChange,
}: {
  values: AddressValues;
  fieldErrors: Record<string, string>;
  /** Applies a partial update, so simultaneous changes cannot overwrite each other. */
  onPatch: (patch: Partial<AddressValues>) => void;
  /** True when the postcode is valid, covered, and the address is filled in. */
  onReadyChange: (ready: boolean) => void;
}) {
  const [postcodeState, setPostcodeState] = useState<PostcodeState>({
    kind: "idle",
  });

  const postcodeUsable = postcodeState.kind === "valid" && postcodeState.covered;
  const ready =
    postcodeUsable &&
    values.houseOrName.trim().length > 0 &&
    values.street.trim().length > 1;

  useEffect(() => {
    onReadyChange(ready);
  }, [ready, onReadyChange]);

  function set<K extends keyof AddressValues>(key: K, value: AddressValues[K]) {
    onPatch({ [key]: value } as Partial<AddressValues>);
  }

  /**
   * The latest values, for the asynchronous lookup below. A handler created in
   * an earlier render would otherwise read a stale postcode.
   */
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  }, [values]);

  const checkPostcode = useCallback(async () => {
    const candidate = normalisePostcode(latest.current.postcode);
    if (!looksLikePostcode(candidate)) {
      setPostcodeState({ kind: "malformed" });
      return;
    }

    setPostcodeState({ kind: "checking" });

    try {
      const response = await fetch("/api/address/postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcode: candidate }),
      });
      const data = await response.json();

      if (data.status === "valid") {
        setPostcodeState({
          kind: "valid",
          postcode: data.postcode.postcode,
          areaName: data.postcode.areaName,
          covered: Boolean(data.covered),
        });
        // The canonical postcode and derived town, not what was typed.
        onPatch({
          postcode: data.postcode.postcode,
          town: data.postcode.areaName || latest.current.town,
        });
        return;
      }

      if (data.status === "not_found") setPostcodeState({ kind: "not_found" });
      else if (data.status === "malformed") setPostcodeState({ kind: "malformed" });
      else setPostcodeState({ kind: "unavailable" });
    } catch {
      // A network failure is our problem, not a wrong postcode.
      setPostcodeState({ kind: "unavailable" });
    }
  }, [onPatch]);

  return (
    <section aria-labelledby="property-address" className="sm:col-span-2">
      <h3
        id="property-address"
        className="text-sm font-bold uppercase tracking-wide text-navy-700"
      >
        Property address
      </h3>

      <div className="mt-3">
        <label htmlFor="postcode" className={labelClass}>
          Postcode
        </label>
        <div className="flex gap-2">
          <input
            id="postcode"
            autoComplete="postal-code"
            required
            placeholder="WV1 1AA"
            value={values.postcode}
            onChange={(event) => {
              setPostcodeState({ kind: "idle" });
              set("postcode", event.target.value.toUpperCase());
            }}
            onBlur={() => {
              if (
                postcodeState.kind === "idle" &&
                looksLikePostcode(latest.current.postcode)
              ) {
                void checkPostcode();
              }
            }}
            className={`${fieldClass} uppercase`}
          />
          <button
            type="button"
            onClick={() => void checkPostcode()}
            disabled={postcodeState.kind === "checking"}
            className="mt-1.5 shrink-0 rounded-xl bg-navy-800 px-4 text-sm font-bold text-white hover:bg-navy-900 disabled:opacity-60"
          >
            {postcodeState.kind === "checking" ? "Checking…" : "Check"}
          </button>
        </div>

        <div aria-live="polite">
          {postcodeState.kind === "checking" && (
            <p className="mt-2 text-sm text-navy-600">Checking postcode…</p>
          )}

          {postcodeState.kind === "valid" && postcodeState.covered && (
            <p className="mt-2 text-sm font-bold text-trust-600">
              ✓ {postcodeState.postcode}
              {postcodeState.areaName ? ` · ${postcodeState.areaName}` : ""} — we
              cover this area
            </p>
          )}

          {postcodeState.kind === "valid" && !postcodeState.covered && (
            <div className="mt-3 rounded-xl border-2 border-flame-500 bg-flame-400/15 p-4">
              <p className="text-sm font-bold text-navy-900">
                This property is outside our standard online booking area.
              </p>
              <p className="mt-1 text-sm leading-relaxed text-navy-800">
                We may still be able to help. Call or WhatsApp us and we&rsquo;ll
                confirm availability.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <a
                  href={business.phoneHref}
                  data-analytics-id="address-outside-call"
                  className="rounded-lg bg-navy-800 px-4 py-3 text-center text-sm font-bold text-white"
                >
                  Call {business.phoneDisplay}
                </a>
                <a
                  href={business.whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-analytics-id="address-outside-whatsapp"
                  className="rounded-lg border-2 border-trust-600 px-4 py-3 text-center text-sm font-bold text-trust-600"
                >
                  WhatsApp us
                </a>
              </div>
            </div>
          )}

          {postcodeState.kind === "not_found" && (
            <p className="mt-2 text-sm font-semibold text-flame-600">
              We couldn&rsquo;t find that postcode. Check it and try again.
            </p>
          )}
          {postcodeState.kind === "malformed" && (
            <p className="mt-2 text-sm font-semibold text-flame-600">
              That doesn&rsquo;t look like a UK postcode. Check it and try again.
            </p>
          )}
          {postcodeState.kind === "unavailable" && (
            <p className="mt-2 text-sm font-semibold text-navy-800">
              We couldn&rsquo;t check the postcode right now. Please try again,
              or{" "}
              <a href={business.phoneHref} className="underline underline-offset-4">
                call us
              </a>{" "}
              to book.
            </p>
          )}
          {fieldErrors.postcode && (
            <p className="mt-1 text-sm font-semibold text-flame-600">
              {fieldErrors.postcode}
            </p>
          )}
        </div>
      </div>

      {postcodeUsable && (
        <>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="houseOrName" className={labelClass}>
                House number or name
              </label>
              <input
                id="houseOrName"
                required
                placeholder="24"
                value={values.houseOrName}
                onChange={(event) => set("houseOrName", event.target.value)}
                className={fieldClass}
              />
              {fieldErrors.houseOrName && (
                <p className="mt-1 text-sm font-semibold text-flame-600">
                  {fieldErrors.houseOrName}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="street" className={labelClass}>
                Street
              </label>
              <input
                id="street"
                autoComplete="address-line1"
                required
                placeholder="Example Road"
                value={values.street}
                onChange={(event) => set("street", event.target.value)}
                className={fieldClass}
              />
              {fieldErrors.street && (
                <p className="mt-1 text-sm font-semibold text-flame-600">
                  {fieldErrors.street}
                </p>
              )}
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-navy-600">
            You&rsquo;ll be asked to check the full address before your booking
            is confirmed.
          </p>
        </>
      )}
    </section>
  );
}
