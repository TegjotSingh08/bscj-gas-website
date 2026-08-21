"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { business } from "@/lib/business";
import { looksLikePostcode, normalisePostcode } from "@/lib/address/format";
import type { AddressVerificationStatus } from "@/lib/address/types";

/**
 * Postcode-first property address entry.
 *
 * The postcode is validated against a real postcode database before anything
 * else is asked, because it is the one field that can be checked hard and for
 * free. The street check that follows is a confidence signal only: open
 * mapping data does not contain every property, so failing to match never
 * blocks a booking — it just asks the customer to confirm.
 */

export type AddressValues = {
  houseOrName: string;
  street: string;
  town: string;
  postcode: string;
  addressConfirmedByCustomer: boolean;
};

type PostcodeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; postcode: string; areaName: string; covered: boolean }
  | { kind: "not_found" }
  | { kind: "malformed" }
  | { kind: "unavailable" };

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "done";
      status: AddressVerificationStatus;
      checkUnavailable: boolean;
      lines: string[];
    }
  | { kind: "error" };

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
  /** True when the address is good enough to continue. */
  onReadyChange: (ready: boolean) => void;
}) {
  const [postcodeState, setPostcodeState] = useState<PostcodeState>({
    kind: "idle",
  });
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: "idle" });

  /** What was verified, so any edit can invalidate it. */
  const verifiedFor = useRef<string | null>(null);

  const postcodeValid =
    postcodeState.kind === "valid" && postcodeState.covered;

  const verified =
    verifyState.kind === "done" && verifyState.status === "verified";

  const ready =
    postcodeValid && (verified || values.addressConfirmedByCustomer);

  useEffect(() => {
    onReadyChange(ready);
  }, [ready, onReadyChange]);

  function set<K extends keyof AddressValues>(key: K, value: AddressValues[K]) {
    onPatch({ [key]: value } as Partial<AddressValues>);
  }

  /**
   * The latest values, for the asynchronous checks below. A blur handler
   * created in an earlier render would otherwise read a stale address.
   */
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  }, [values]);

  /** Any change to the address invalidates a previous verification. */
  const invalidateVerification = useCallback(() => {
    verifiedFor.current = null;
    setVerifyState({ kind: "idle" });
    onPatch({ addressConfirmedByCustomer: false });
  }, [onPatch]);

  async function checkPostcode() {
    const candidate = normalisePostcode(latest.current.postcode);
    if (!looksLikePostcode(candidate)) {
      setPostcodeState({ kind: "malformed" });
      return;
    }

    setPostcodeState({ kind: "checking" });
    invalidateVerification();

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
        // Use the canonical postcode and derived town, not what was typed.
        onPatch({
          postcode: data.postcode.postcode,
          town: data.postcode.areaName || latest.current.town,
          addressConfirmedByCustomer: false,
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
  }

  async function checkAddress() {
    if (!postcodeValid) return;
    const current = latest.current;
    if (!current.houseOrName.trim() || current.street.trim().length < 2) return;

    const signature = `${current.postcode}|${current.houseOrName}|${current.street}`;
    if (verifiedFor.current === signature) return;

    setVerifyState({ kind: "checking" });
    try {
      const response = await fetch("/api/address/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          houseOrName: current.houseOrName,
          street: current.street,
          postcode: current.postcode,
        }),
      });

      if (!response.ok) {
        setVerifyState({ kind: "error" });
        return;
      }

      const data = await response.json();
      verifiedFor.current = signature;
      setVerifyState({
        kind: "done",
        status: data.status,
        checkUnavailable: Boolean(data.checkUnavailable),
        lines: data.address?.lines ?? [],
      });

      if (data.status === "verified") {
        onPatch({
          town: data.address?.town || current.town,
          addressConfirmedByCustomer: false,
        });
      }
    } catch {
      setVerifyState({ kind: "error" });
    }
  }

  const enteredLines = [
    [values.houseOrName, values.street].filter(Boolean).join(" "),
    values.town,
    values.postcode,
  ].filter(Boolean);

  return (
    <section aria-labelledby="property-address" className="sm:col-span-2">
      <h3 id="property-address" className="text-sm font-bold uppercase tracking-wide text-navy-700">
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
            placeholder="WV6 0AR"
            value={values.postcode}
            onChange={(event) => {
              setPostcodeState({ kind: "idle" });
              invalidateVerification();
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
                The postcode is fine — it is just outside the area we book
                online. Call or WhatsApp us and we will check whether we can
                cover it.
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
              We couldn&rsquo;t verify the postcode right now. You can try again,
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

      {postcodeValid && (
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="houseOrName" className={labelClass}>
              House number or name
            </label>
            <input
              id="houseOrName"
              required
              placeholder="197"
              value={values.houseOrName}
              onChange={(event) => {
                invalidateVerification();
                set("houseOrName", event.target.value);
              }}
              onBlur={() => void checkAddress()}
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
              placeholder="Sweetman Street"
              value={values.street}
              onChange={(event) => {
                invalidateVerification();
                set("street", event.target.value);
              }}
              onBlur={() => void checkAddress()}
              className={fieldClass}
            />
            {fieldErrors.street && (
              <p className="mt-1 text-sm font-semibold text-flame-600">
                {fieldErrors.street}
              </p>
            )}
          </div>
        </div>
      )}

      {postcodeValid && values.houseOrName && values.street && (
        <div className="mt-4" aria-live="polite">
          {verifyState.kind === "checking" && (
            <p className="text-sm text-navy-600">Checking address…</p>
          )}

          {verifyState.kind === "done" && verifyState.status === "verified" && (
            <div className="rounded-xl border-2 border-trust-600 bg-trust-50 p-4">
              <p className="text-sm font-bold text-trust-600">
                ✓ Address verified
              </p>
              <p className="mt-1 text-base font-bold leading-relaxed text-navy-900">
                {verifyState.lines.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </p>
            </div>
          )}

          {verifyState.kind === "done" && verifyState.status !== "verified" && (
            <UnverifiedPanel
              partial={verifyState.status === "partial_match"}
              lines={enteredLines}
              confirmed={values.addressConfirmedByCustomer}
              onConfirm={(confirmed) =>
                set("addressConfirmedByCustomer", confirmed)
              }
            />
          )}

          {verifyState.kind === "error" && (
            <UnverifiedPanel
              lines={enteredLines}
              confirmed={values.addressConfirmedByCustomer}
              onConfirm={(confirmed) =>
                set("addressConfirmedByCustomer", confirmed)
              }
            />
          )}

          {verifyState.kind === "idle" && (
            <button
              type="button"
              onClick={() => void checkAddress()}
              className="text-sm font-bold text-flame-600 underline underline-offset-4"
            >
              Check this address
            </button>
          )}
        </div>
      )}

      {postcodeValid && (
        <p className="mt-3 text-xs text-navy-500">
          Address checking uses{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            OpenStreetMap
          </a>{" "}
          data. It is a helpful check, not an official Royal Mail lookup.
        </p>
      )}
    </section>
  );
}

/**
 * Shown whenever the address could not be confirmed automatically — including
 * when the check itself was unavailable. Never phrased as the address being
 * wrong, because we do not know that.
 */
function UnverifiedPanel({
  partial = false,
  lines,
  confirmed,
  onConfirm,
}: {
  /** True when the street was found but the exact property could not be. */
  partial?: boolean;
  lines: string[];
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}) {
  return (
    <div className="rounded-xl border-2 border-navy-200 bg-navy-50 p-4">
      <p className="text-sm font-bold text-navy-900">
        {partial
          ? "We found this street, but couldn't confirm the exact property."
          : "We couldn't automatically verify this property address."}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-navy-700">
        That is normal — the free map data we check against does not list every
        house number, flat or new build. Please check it reads correctly.
      </p>
      <p className="mt-3 text-base font-bold leading-relaxed text-navy-900">
        {lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </p>
      <label className="mt-4 flex items-start gap-3 text-sm font-semibold text-navy-900">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirm(event.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-2 border-navy-300"
        />
        I confirm this property address is correct.
      </label>
    </div>
  );
}
