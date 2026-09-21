"use client";

import { useActionState } from "react";

import { saveImportProfileAction, type ActionState } from "../actions";
import { submitClass } from "../form-parts";
import { COLUMNS } from "@/lib/portfolio/import/columns";
import { PROFILE_CHOICES, type ImportProfile } from "@/lib/portfolio/import/profile";

/**
 * How one agency's spreadsheet is read.
 *
 * Filled in once, by BSCJ, after looking at the agency's export. The agency
 * then uploads against it and cannot change it — which is the point: what a
 * column means is a decision somebody made while looking at a real file, not
 * something to be re-guessed on every upload.
 *
 * **One form for every agency.** Nothing here is named after a particular one;
 * a new agency is rows in this form, never a release. Routine adjustments —
 * the export gained a column, a heading was renamed — are an edit here.
 */

const fieldClass =
  "mt-1 w-full rounded-lg border-2 border-navy-200 bg-white px-3 py-2 text-sm text-navy-900 focus:border-flame-500 focus:outline-none";

function Choice<T extends string>({
  name,
  legend,
  choices,
  current,
}: {
  name: string;
  legend: string;
  choices: readonly { value: T; label: string; detail: string }[];
  current: T;
}) {
  return (
    <fieldset className="rounded-xl border-2 border-navy-100 p-4">
      <legend className="px-1 text-xs font-extrabold uppercase tracking-wide text-navy-600">
        {legend}
      </legend>
      <div className="space-y-2">
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={choice.value}
              defaultChecked={current === choice.value}
              className="mt-1"
            />
            <span>
              <span className="font-bold text-navy-900">{choice.label}</span>
              <span className="block text-xs text-navy-600">{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ImportProfileForm({
  organisationId,
  profile,
  configured,
}: {
  organisationId: string;
  profile: ImportProfile;
  configured: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveImportProfileAction,
    {},
  );

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="organisationId" value={organisationId} />

      {state.message && (
        <p
          role="status"
          className="mb-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {state.message}
        </p>
      )}

      <p className="text-sm text-navy-700">
        {configured
          ? "This agency's export is set up. Changing it applies to their next upload — nothing already imported is touched, and any preview they have open will ask them to upload again."
          : "Not set up yet, so their uploads are read using the standard template headings. Fill this in once you have seen their export."}
      </p>

      <h4 className="mt-5 text-xs font-extrabold uppercase tracking-wide text-navy-600">
        Their headings
      </h4>
      <p className="mt-1 text-xs text-navy-600">
        For each thing we need, type the heading their spreadsheet uses. Leave
        blank where their export does not have it. Capitals, spaces and
        underscores do not matter.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {COLUMNS.map((column) => (
          <div key={column.key}>
            <label
              htmlFor={`column-${column.key}`}
              className="block text-xs font-bold text-navy-900"
            >
              {column.header}
              {column.required && <span className="text-flame-600"> *</span>}
            </label>
            <input
              id={`column-${column.key}`}
              name={`column-${column.key}`}
              type="text"
              defaultValue={profile.columns[column.key] ?? ""}
              placeholder={column.header}
              className={fieldClass}
            />
            {state.errors?.[`column-${column.key}`] && (
              <p className="mt-1 text-xs font-semibold text-flame-600">
                {state.errors[`column-${column.key}`]}
              </p>
            )}
          </div>
        ))}
      </div>

      <h4 className="mt-6 text-xs font-extrabold uppercase tracking-wide text-navy-600">
        What their columns mean
      </h4>
      <p className="mt-1 text-xs text-navy-600">
        The four things a heading cannot tell us. Each defaults to the cautious
        reading — change one only once the agency has confirmed it.
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Choice
          name="occupierRole"
          legend="The second person-name column"
          choices={PROFILE_CHOICES.occupierRole}
          current={profile.occupierRole}
        />
        <Choice
          name="landlordMatch"
          legend="When landlord contact details are missing"
          choices={PROFILE_CHOICES.landlordMatch}
          current={profile.landlordMatch}
        />
        <Choice
          name="addressMode"
          legend="Addresses"
          choices={PROFILE_CHOICES.addressMode}
          current={profile.addressMode}
        />
        <Choice
          name="dateOrder"
          legend="Dates"
          choices={PROFILE_CHOICES.dateOrder}
          current={profile.dateOrder}
        />
      </div>

      <div className="mt-5">
        <label htmlFor="notes" className="block text-xs font-bold text-navy-900">
          What you noticed about their export
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={profile.notes}
          className={fieldClass}
          placeholder="Internal only. Never shown to the agency."
        />
        {state.errors?.notes && (
          <p className="mt-1 text-xs font-semibold text-flame-600">
            {state.errors.notes}
          </p>
        )}
      </div>

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : configured ? "Update profile" : "Save profile"}
      </button>
    </form>
  );
}
