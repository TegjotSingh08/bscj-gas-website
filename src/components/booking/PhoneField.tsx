"use client";

import { normaliseUkMobile, phoneProblemMessage } from "@/lib/booking/contact";

/**
 * UK mobile input with a fixed +44 prefix.
 *
 * The country code is shown rather than typed, so nobody has to think about
 * it. What they type is validated with the same implementation the server
 * uses, so the two can never disagree.
 */
export function PhoneField({
  id,
  label,
  value,
  optional = false,
  hint,
  serverError,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  optional?: boolean;
  hint?: string;
  serverError?: string;
  onChange: (value: string) => void;
}) {
  const trimmed = value.trim();
  const result = trimmed ? normaliseUkMobile(trimmed) : null;

  // Only complain once there is enough typed to be a real attempt, so the
  // field does not turn red on the first keystroke.
  const showProblem =
    result !== null && !result.ok && trimmed.replace(/\D/g, "").length >= 6;

  const message = serverError
    ? serverError
    : showProblem && result && !result.ok
      ? phoneProblemMessage(result.reason)
      : null;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-bold text-navy-900">
        {label}{" "}
        {optional && (
          <span className="font-medium text-navy-500">(optional)</span>
        )}
      </label>

      <div
        className={[
          "mt-1.5 flex items-stretch overflow-hidden rounded-xl border-2 bg-white",
          message ? "border-flame-500" : "border-navy-200",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="flex items-center border-r-2 border-navy-200 bg-navy-50 px-3 text-base font-bold text-navy-700"
        >
          +44
        </span>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete={optional ? "off" : "tel-national"}
          required={!optional}
          placeholder="7700 900123"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={message ? `${id}-error` : hint ? `${id}-hint` : undefined}
          aria-invalid={message ? true : undefined}
          className="w-full px-4 py-3 text-base text-navy-900 placeholder:text-navy-400 focus:outline-none"
        />
      </div>

      {message ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-semibold text-flame-600">
          {message}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1 text-xs text-navy-600">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
