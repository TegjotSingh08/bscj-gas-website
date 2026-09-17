"use client";

/** Shared form furniture for the agency screens. Presentation only. */

export const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-2.5 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

export const submitClass =
  "mt-6 rounded-xl bg-flame-500 px-6 py-3 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60";

export function Field({
  name,
  label,
  type = "text",
  required = false,
  autoComplete,
  error,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-bold text-navy-900">
        {label}
        {required && <span className="text-flame-600"> *</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={fieldClass}
      />
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs font-semibold text-flame-600">
          {error}
        </p>
      )}
    </div>
  );
}
