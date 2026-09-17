"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { createPropertyAction, type ActionState } from "../actions";
import { Field, Notice, fieldClass, primaryClass } from "../form-parts";

/**
 * Adding a property.
 *
 * Optimised for the thing an agent actually does: sit with a list and enter
 * twenty addresses. So it is **one page, not a wizard** — every field is
 * visible, nothing is behind a "next" button, and the only thing that blocks
 * progress is a postcode that is not real.
 *
 * The postcode lookup fills in the town, so the agent types what the system
 * cannot derive and nothing it can. There is no premise lookup: no free
 * service can prove a house exists at a postcode, so the house number or name
 * is still typed, exactly as a customer types it on the public site.
 *
 * Everything below the address is optional. A property with no tenant and no
 * certificate date is a real and common state — an agency that has just taken
 * a portfolio on often has nothing else yet — and refusing to record it would
 * push the whole list into a spreadsheet.
 */

type Landlord = { id: string; name: string; company: string | null };

type PostcodeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; town: string; postcode: string; inStandardArea: boolean }
  | { kind: "invalid"; message: string };

export function AddPropertyForm({ landlords }: { landlords: Landlord[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createPropertyAction,
    {},
  );

  const [landlordId, setLandlordId] = useState(
    landlords.length > 0 ? landlords[0].id : "",
  );
  const [postcode, setPostcode] = useState<PostcodeState>({ kind: "idle" });
  const [town, setTown] = useState("");

  async function checkPostcode(value: string) {
    const trimmed = value.trim();
    if (trimmed.length < 5) {
      setPostcode({ kind: "idle" });
      return;
    }

    setPostcode({ kind: "checking" });
    try {
      const response = await fetch("/api/portal/postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcode: trimmed }),
      });
      const data = (await response.json()) as {
        status: string;
        postcode?: string;
        town?: string;
        inStandardArea?: boolean;
      };

      if (data.status === "valid" && data.postcode) {
        setPostcode({
          kind: "valid",
          postcode: data.postcode,
          town: data.town ?? "",
          inStandardArea: Boolean(data.inStandardArea),
        });
        // Filled in, and still editable: the provider's area name is a good
        // guess at the town and is occasionally not the one people use.
        if (data.town) setTown(data.town);
        return;
      }

      setPostcode({
        kind: "invalid",
        message:
          data.status === "not_found"
            ? "We could not find that postcode."
            : data.status === "provider_unavailable"
              ? "The postcode service is unavailable. You can still save and correct it later."
              : "That does not look like a UK postcode.",
      });
    } catch {
      setPostcode({
        kind: "invalid",
        message: "The postcode service is unavailable.",
      });
    }
  }

  return (
    <form action={action} className="mt-6 space-y-6">
      {state.message && <Notice tone="error">{state.message}</Notice>}

      {/* ---- Landlord ---- */}
      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Landlord</h2>

        {landlords.length > 0 && (
          <div className="mt-3">
            <label
              htmlFor="landlordId"
              className="block text-sm font-bold text-navy-900"
            >
              Existing landlord
            </label>
            <select
              id="landlordId"
              name="landlordId"
              value={landlordId}
              onChange={(event) => setLandlordId(event.target.value)}
              className={fieldClass}
            >
              {landlords.map((landlord) => (
                <option key={landlord.id} value={landlord.id}>
                  {landlord.name}
                  {landlord.company ? ` — ${landlord.company}` : ""}
                </option>
              ))}
              <option value="">+ Add a new landlord</option>
            </select>
          </div>
        )}

        {landlordId === "" && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              name="name"
              label="Landlord name"
              required
              error={state.errors?.name}
            />
            <Field name="company" label="Company" error={state.errors?.company} />
            <Field
              name="email"
              label="Email"
              type="email"
              required
              error={state.errors?.email}
            />
            <Field
              name="phone"
              label="Phone"
              required
              error={state.errors?.phone}
            />
          </div>
        )}
      </section>

      {/* ---- Address ---- */}
      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">Address</h2>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="postcode"
              className="block text-sm font-bold text-navy-900"
            >
              Postcode<span className="text-flame-600"> *</span>
            </label>
            <input
              id="postcode"
              name="postcode"
              required
              autoComplete="off"
              onBlur={(event) => void checkPostcode(event.target.value)}
              className={fieldClass}
            />
            {postcode.kind === "checking" && (
              <p className="mt-1 text-xs text-navy-600">Checking…</p>
            )}
            {postcode.kind === "valid" && (
              <p className="mt-1 text-xs font-semibold text-navy-700">
                {postcode.postcode} · {postcode.town}
                {!postcode.inStandardArea &&
                  " · outside the standard booking area — we will confirm cover"}
              </p>
            )}
            {postcode.kind === "invalid" && (
              <p className="mt-1 text-xs font-semibold text-flame-600">
                {postcode.message}
              </p>
            )}
            {state.errors?.postcode && (
              <p className="mt-1 text-xs font-semibold text-flame-600">
                {state.errors.postcode}
              </p>
            )}
          </div>

          <Field
            name="houseOrName"
            label="House number or name"
            required
            placeholder="24, or Rose Cottage"
            error={state.errors?.houseOrName}
          />
          <Field
            name="street"
            label="Street"
            required
            error={state.errors?.street}
          />
          <div>
            <label htmlFor="town" className="block text-sm font-bold text-navy-900">
              Town
            </label>
            <input
              id="town"
              name="town"
              value={town}
              onChange={(event) => setTown(event.target.value)}
              className={fieldClass}
            />
            <p className="mt-1 text-xs text-navy-600">
              Filled in from the postcode. Change it if it is wrong.
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label
            htmlFor="accessNotes"
            className="block text-sm font-bold text-navy-900"
          >
            Access notes
          </label>
          <textarea
            id="accessNotes"
            name="accessNotes"
            rows={2}
            placeholder="Key safe, parking, side gate…"
            className={fieldClass}
          />
        </div>
      </section>

      {/* ---- Tenant ---- */}
      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">
          Tenant <span className="font-normal text-navy-600">— optional</span>
        </h2>
        <p className="mt-1 text-sm text-navy-600">
          Leave blank if the property is empty or you do not have the details
          yet. You can add them later, and we will need them before a tenant can
          choose their own appointment.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field name="tenantName" label="Name" error={state.errors?.tenantName} />
          <Field
            name="tenantPhone"
            label="Mobile"
            hint="A mobile, so we can send a scheduling link."
            error={state.errors?.tenantPhone}
          />
          <Field
            name="tenantEmail"
            label="Email"
            type="email"
            error={state.errors?.tenantEmail}
          />
          <Field
            name="tenancyStartedOn"
            label="Tenancy started"
            type="date"
            error={state.errors?.tenancyStartedOn}
          />
        </div>
      </section>

      {/* ---- Compliance ---- */}
      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">
          Current certificate{" "}
          <span className="font-normal text-navy-600">— optional</span>
        </h2>
        <p className="mt-1 text-sm text-navy-600">
          If you know when the current CP12 runs out, add it and we will tell
          you when the renewal is coming. Leave it blank if you do not — we will
          not guess.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            name="certificateExpiry"
            label="Expires"
            type="date"
            error={state.errors?.certificateExpiry}
          />
          <Field
            name="lastInspection"
            label="Last inspected"
            type="date"
            hint="Only if you have it."
            error={state.errors?.lastInspection}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? "Saving…" : "Save property"}
        </button>
        <Link
          href="/portal/portfolio"
          className="text-sm font-bold text-navy-600 underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
