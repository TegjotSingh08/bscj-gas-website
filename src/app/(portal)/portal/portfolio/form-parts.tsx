"use client";

/** Shared form furniture for the portfolio screens. Presentation only. */

export const fieldClass =
  "mt-1.5 w-full rounded-xl border-2 border-navy-200 bg-white px-4 py-2.5 text-base text-navy-900 focus:border-flame-500 focus:outline-none";

export const primaryClass =
  "rounded-xl bg-flame-500 px-6 py-3 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60";

export const secondaryClass =
  "rounded-xl border-2 border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-900 hover:border-navy-600";

export function Field({
  name,
  label,
  type = "text",
  required = false,
  defaultValue,
  placeholder,
  hint,
  error,
  readOnly = false,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  readOnly?: boolean;
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
        defaultValue={defaultValue}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className={readOnly ? `${fieldClass} bg-navy-50` : fieldClass}
      />
      {hint && !error && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-navy-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs font-semibold text-flame-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
          : "mb-4 rounded-xl border-2 border-navy-200 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
      }
    >
      {children}
    </p>
  );
}
