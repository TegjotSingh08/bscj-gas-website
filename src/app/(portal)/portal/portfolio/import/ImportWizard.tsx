"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import {
  confirmImportAction,
  previewImportAction,
  type ConfirmState,
  type PreviewState,
} from "./actions";
import type { PlannedRow, RowAction } from "@/lib/portfolio/import/plan";
import { PROFILE_CHOICES } from "@/lib/portfolio/import/profile";

/**
 * Upload, review, confirm.
 *
 * Three states in one component because they are one task: the agent needs the
 * preview still on screen while they decide, and a wizard that navigated away
 * would either lose the review or need somewhere to store it.
 *
 * The signed plan travels in a hidden field. It is what the server writes from
 * — not the table below, which is presentation — so nothing rendered here can
 * change what happens, however it is edited in a browser's dev tools.
 */

const ACTION_LABEL: Record<RowAction, string> = {
  create: "Will be added",
  duplicate_in_file: "Repeated in your file",
  conflict: "Differs from your record",
  unchanged: "Already matches",
  error: "Cannot be read",
};

const ACTION_CLASS: Record<RowAction, string> = {
  create: "bg-navy-50 text-navy-900 border-navy-200",
  duplicate_in_file: "bg-white text-navy-700 border-navy-200",
  conflict: "bg-flame-400/10 text-navy-900 border-flame-500",
  unchanged: "bg-white text-navy-600 border-navy-100",
  error: "bg-flame-400/10 text-navy-900 border-flame-500",
};

function Badge({ action }: { action: RowAction }) {
  return (
    <span
      className={`inline-block rounded-lg border-2 px-2 py-0.5 text-xs font-bold ${ACTION_CLASS[action]}`}
    >
      {ACTION_LABEL[action]}
    </span>
  );
}

export function ImportWizard() {
  const [preview, previewAction, previewPending] = useActionState<
    PreviewState,
    FormData
  >(previewImportAction, {});
  const [confirmed, confirmAction, confirmPending] = useActionState<
    ConfirmState,
    FormData
  >(confirmImportAction, {});

  if (confirmed.done) return <Result state={confirmed} />;

  return (
    <>
      <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">
          2. Upload your file
        </h2>

        <form action={previewAction} className="mt-4">
          {preview.error && (
            <p
              role="alert"
              className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
            >
              {preview.error}
            </p>
          )}

          {preview.missingColumns && preview.missingColumns.length > 0 && (
            <p className="mb-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm text-navy-900">
              Still needed:{" "}
              <span className="font-mono text-xs font-bold">
                {preview.missingColumns.join(", ")}
              </span>
            </p>
          )}

          {preview.duplicatedColumns && preview.duplicatedColumns.length > 0 && (
            <p className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm text-navy-900">
              Claimed twice:{" "}
              <span className="font-mono text-xs font-bold">
                {preview.duplicatedColumns.join(", ")}
              </span>
              . Two columns cannot mean the same thing — pick one.
            </p>
          )}

          {/*
            The mapping panel appears once a file has been read, whether it
            succeeded or not — a failed read is exactly when an agent needs to
            say what their headings mean, and re-uploading the same file with
            the choices attached is one click.
          */}
          {preview.resolved && preview.resolved.length > 0 && (
            <MappingPanel
              resolved={preview.resolved}
              configured={preview.profileConfigured === true}
              profile={preview.profile}
            />
          )}

          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className="block w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-sm text-navy-900 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-100 file:px-4 file:py-2 file:text-sm file:font-bold file:text-navy-900"
          />

          <button
            type="submit"
            disabled={previewPending}
            className="mt-4 rounded-xl bg-flame-500 px-6 py-3 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
          >
            {previewPending ? "Reading…" : "Check my file"}
          </button>
          <p className="mt-2 text-xs text-navy-600">
            This reads the file and shows you what it would do. It writes
            nothing.
          </p>
        </form>
      </section>

      {preview.plan && preview.sealed && (
        <Review
          plan={preview.plan}
          sealed={preview.sealed}
          filename={preview.filename}
          unknownColumns={preview.unknownColumns}
          action={confirmAction}
          pending={confirmPending}
          error={confirmed.error}
        />
      )}
    </>
  );
}

const VIA_LABEL: Record<string, string> = {
  template: "standard heading",
  saved: "your agency's profile",
  chosen: "chosen for this upload",
  unmapped: "not used",
};

function choiceLabel<T extends string>(
  choices: readonly { value: T; label: string }[],
  value: T | undefined,
): string {
  return choices.find((choice) => choice.value === value)?.label ?? String(value);
}

/**
 * How this file was read, shown before anything is written.
 *
 * **Read-only.** What a column means is BSCJ's decision, taken once after
 * looking at the agency's spreadsheet and recorded as a profile, so every
 * upload is read the same way and an agent cannot change it mid-import — by
 * accident or otherwise. What the agent gets is the clear preview: every
 * heading, what it was taken to be, and the four readings that a heading alone
 * cannot express.
 */
function MappingPanel({
  resolved,
  configured,
  profile,
}: {
  resolved: NonNullable<PreviewState["resolved"]>;
  configured: boolean;
  profile: PreviewState["profile"];
}) {
  const used = resolved.filter((column) => column.key);
  const ignored = resolved.filter((column) => !column.key);

  return (
    <details className="mb-4 rounded-xl border-2 border-navy-200 bg-white p-4" open>
      <summary className="cursor-pointer text-sm font-bold text-navy-900">
        How we read your file ({used.length} of {resolved.length} columns used)
      </summary>

      <p className="mt-2 text-xs text-navy-600">
        {configured
          ? "BSCJ has set up how your spreadsheet is read. If any of this is wrong, tell us and we will change it — do not edit your file."
          : "Read using the standard headings, because no profile has been set up for your agency yet. If your export uses different wording, ask BSCJ to set one up."}
      </p>

      <ul className="mt-3 space-y-1 text-sm">
        {used.map((column) => (
          <li
            key={`${column.header}-${column.index}`}
            className="sm:grid sm:grid-cols-2 sm:gap-3"
          >
            <span className="font-mono text-xs font-bold text-navy-900">
              {column.header || <em className="font-sans">(no heading)</em>}
            </span>
            <span className="text-navy-700">
              {column.key}{" "}
              <span className="text-xs text-navy-600">
                ({VIA_LABEL[column.via] ?? column.via})
              </span>
            </span>
          </li>
        ))}
      </ul>

      {ignored.length > 0 && (
        <p className="mt-3 text-xs text-navy-600">
          Not used:{" "}
          <span className="font-mono font-bold">
            {ignored.map((column) => column.header).join(", ")}
          </span>
        </p>
      )}

      {profile && (
        <dl className="mt-4 grid gap-2 border-t-2 border-navy-100 pt-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-bold uppercase tracking-wide text-navy-600">
              Second name column
            </dt>
            <dd className="text-navy-900">
              {choiceLabel(PROFILE_CHOICES.occupierRole, profile.occupierRole)}
            </dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-wide text-navy-600">
              Dates
            </dt>
            <dd className="text-navy-900">
              {choiceLabel(PROFILE_CHOICES.dateOrder, profile.dateOrder)}
            </dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-wide text-navy-600">
              Addresses
            </dt>
            <dd className="text-navy-900">
              {choiceLabel(PROFILE_CHOICES.addressMode, profile.addressMode)}
            </dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-wide text-navy-600">
              Missing landlord contact
            </dt>
            <dd className="text-navy-900">
              {choiceLabel(PROFILE_CHOICES.landlordMatch, profile.landlordMatch)}
            </dd>
          </div>
        </dl>
      )}
    </details>
  );
}

function Review({
  plan,
  sealed,
  filename,
  unknownColumns,
  action,
  pending,
  error,
}: {
  plan: NonNullable<PreviewState["plan"]>;
  sealed: string;
  filename?: string;
  unknownColumns?: string[];
  action: (formData: FormData) => void;
  pending: boolean;
  error?: string;
}) {
  const { counts } = plan;
  const conflicts = plan.rows.filter((row) => row.action === "conflict");
  const errors = plan.rows.filter((row) => row.action === "error");

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="plan" value={sealed} />

      <section className="rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">
          3. Check what this will do
        </h2>
        {filename && (
          <p className="mt-1 text-xs text-navy-600">
            From <span className="font-bold">{filename}</span>
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
          >
            {error}
          </p>
        )}

        {unknownColumns && unknownColumns.length > 0 && (
          <p className="mt-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm text-navy-900">
            These columns were not recognised and will be ignored:{" "}
            <span className="font-mono text-xs font-bold">
              {unknownColumns.join(", ")}
            </span>
            . If one of them holds something you need, rename it to match the
            template and upload again.
          </p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Count label="To be added" value={counts.create} emphasis />
          <Count label="Need a decision" value={counts.conflict} />
          <Count label="Already match" value={counts.unchanged} />
          <Count label="Repeated" value={counts.duplicate_in_file} />
          <Count label="Cannot be read" value={counts.error} />
        </dl>

        {errors.length > 0 && (
          <div className="mt-5 rounded-xl border-2 border-flame-500 bg-flame-400/10 p-4">
            <h3 className="text-sm font-extrabold text-navy-900">
              {errors.length} row{errors.length === 1 ? "" : "s"} cannot be read
            </h3>
            <p className="mt-1 text-xs text-navy-700">
              These are skipped. Everything else can still go in — fix these in
              your spreadsheet and upload it again afterwards.
            </p>
            <ul className="mt-3 space-y-2">
              {errors.slice(0, 50).map((row) => (
                <li key={row.line} className="text-sm">
                  <span className="font-bold text-navy-900">
                    Row {row.line}
                  </span>{" "}
                  <span className="text-navy-700">{row.address}</span>
                  <ul className="mt-1 ml-4 list-disc text-xs text-navy-700">
                    {row.errors?.map((problem, index) => (
                      <li key={index}>
                        <span className="font-mono font-bold">
                          {problem.column}
                        </span>
                        : {problem.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {errors.length > 50 && (
              <p className="mt-2 text-xs text-navy-600">
                …and {errors.length - 50} more.
              </p>
            )}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-extrabold text-navy-900">
              {conflicts.length} propert{conflicts.length === 1 ? "y" : "ies"}{" "}
              you already have, with differences
            </h3>
            <p className="mt-1 text-xs text-navy-700">
              Nothing here changes unless you tick it. Leaving a row alone keeps
              what you already have.
            </p>

            <ul className="mt-3 space-y-3">
              {conflicts.map((row) => (
                <ConflictRow key={row.line} row={row} />
              ))}
            </ul>
          </div>
        )}

        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-bold text-navy-900">
            Every row ({plan.rows.length})
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b-2 border-navy-200 text-xs uppercase tracking-wide text-navy-600">
                  <th className="py-2 pr-3 font-bold">Row</th>
                  <th className="py-2 pr-3 font-bold">Property</th>
                  <th className="py-2 pr-3 font-bold">Landlord</th>
                  <th className="py-2 pr-3 font-bold">Certificate expiry</th>
                  <th className="py-2 font-bold">What happens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {plan.rows.map((row) => (
                  <tr key={row.line}>
                    <td className="py-2 pr-3 align-top text-navy-600">
                      {row.line}
                    </td>
                    <td className="py-2 pr-3 align-top text-navy-900">
                      {row.address}
                      {row.action === "duplicate_in_file" && (
                        <span className="block text-xs text-navy-600">
                          Same as row {row.duplicateOfLine}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 align-top text-navy-700">
                      {row.record?.landlord.name ?? "—"}
                      {row.landlordExisting && (
                        <span className="block text-xs text-navy-600">
                          Already on file — will be reused
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 align-top text-navy-700">
                      {row.dueDateLong ?? "Not known"}
                    </td>
                    <td className="py-2 align-top">
                      <Badge action={row.action} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
        <h2 className="text-sm font-extrabold text-navy-900">4. Confirm</h2>
        <p className="mt-2 text-sm text-navy-700">
          This adds <span className="font-bold">{counts.create}</span>{" "}
          propert{counts.create === 1 ? "y" : "ies"}, plus any differences you
          ticked above. No work is booked and no tenant is contacted.
        </p>
        <button
          type="submit"
          disabled={pending || counts.create + conflicts.length === 0}
          className="mt-4 rounded-xl bg-flame-500 px-6 py-3 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import these properties"}
        </button>
        {counts.create + conflicts.length === 0 && (
          <p className="mt-2 text-xs text-navy-600">
            There is nothing to write — every row is already in your portfolio,
            repeated, or could not be read.
          </p>
        )}
      </section>
    </form>
  );
}

/**
 * One conflicting property.
 *
 * The checkbox is **unticked by default and named per row**, so the submission
 * carries an explicit decision for each one and an absent value is read as
 * "leave it alone". A row whose differences an import may not apply gets no
 * checkbox at all, rather than one that would silently do nothing.
 */
function ConflictRow({ row }: { row: PlannedRow }) {
  const [apply, setApply] = useState(false);
  const applicable = row.conflictsApplicable === true;

  return (
    <li className="rounded-xl border-2 border-flame-500 bg-flame-400/5 p-4">
      <p className="text-sm font-bold text-navy-900">
        Row {row.line} — {row.address}
      </p>

      <ul className="mt-2 space-y-2">
        {row.conflicts?.map((conflict, index) => (
          <li key={index} className="text-sm">
            <span className="font-bold text-navy-900">{conflict.field}</span>
            <div className="mt-0.5 grid gap-1 sm:grid-cols-2">
              <p className="text-navy-700">
                <span className="text-xs uppercase tracking-wide text-navy-600">
                  You have
                </span>
                <br />
                {conflict.current}
              </p>
              <p className="text-navy-700">
                <span className="text-xs uppercase tracking-wide text-navy-600">
                  Your file says
                </span>
                <br />
                {conflict.incoming}
              </p>
            </div>
            <p className="mt-1 text-xs text-navy-600">{conflict.effect}</p>
          </li>
        ))}
      </ul>

      {applicable ? (
        <label className="mt-3 flex items-start gap-2 text-sm font-bold text-navy-900">
          <input
            type="checkbox"
            name={`resolution-${row.line}`}
            value="update"
            checked={apply}
            onChange={(event) => setApply(event.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          Apply these changes to this property
        </label>
      ) : (
        <p className="mt-3 text-xs font-bold text-navy-700">
          This one needs changing on the property itself — an import will not do
          it.
        </p>
      )}
    </li>
  );
}

function Count({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border-2 p-3 ${
        emphasis ? "border-navy-600 bg-navy-50" : "border-navy-200 bg-white"
      }`}
    >
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-2xl font-extrabold text-navy-900">{value}</dd>
    </div>
  );
}

/**
 * What actually happened.
 *
 * Reports a partial failure **as a partial failure**, with the rows that did
 * not go in named by line number. "Some of it worked" is not something an
 * agent can act on; "rows 14 and 88 did not" is.
 */
function Result({ state }: { state: ConfirmState }) {
  const done = state.done;
  if (!done) return null;

  const failed = done.rows.filter((row) => row.outcome === "failed");
  const skipped = done.rows.filter((row) => row.outcome === "skipped");

  return (
    <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-lg font-extrabold text-navy-900">
        {done.failed === 0 ? "Import finished" : "Import partly finished"}
      </h2>

      {done.repeat && (
        <p className="mt-2 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm text-navy-900">
          This import had already been submitted, so nothing was written twice.
          Here is what it did the first time.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count label="Added" value={done.created} emphasis />
        <Count label="Updated" value={done.updated} />
        <Count label="Left alone" value={done.skipped} />
        <Count label="Failed" value={done.failed} />
      </dl>

      {failed.length > 0 && (
        <div className="mt-5 rounded-xl border-2 border-flame-500 bg-flame-400/10 p-4">
          <h3 className="text-sm font-extrabold text-navy-900">
            These rows did not go in
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-navy-700">
            {failed.map((row) => (
              <li key={row.line}>
                Row {row.line} — {"reason" in row ? row.reason : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-navy-600">
            Everything else is in. Fix these rows and import them on their own —
            re-uploading the whole file is safe, the rest will show as already
            in your portfolio.
          </p>
        </div>
      )}

      {skipped.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-bold text-navy-900">
            {skipped.length} row{skipped.length === 1 ? "" : "s"} left alone
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-navy-700">
            {skipped.map((row) => (
              <li key={row.line}>
                Row {row.line} — {"reason" in row ? row.reason : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          href="/portal/portfolio"
          className="rounded-xl bg-flame-500 px-6 py-3 text-base font-bold text-white hover:bg-flame-600"
        >
          See my portfolio
        </Link>
        <Link
          href="/portal/portfolio/import"
          className="rounded-xl border-2 border-navy-200 px-6 py-3 text-base font-bold text-navy-900 hover:border-navy-600"
        >
          Import another file
        </Link>
      </div>
    </section>
  );
}
