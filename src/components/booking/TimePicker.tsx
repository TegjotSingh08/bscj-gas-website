"use client";

import { cp12 } from "@/lib/business";
import type { Slot } from "./BookingFlow";

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function TimePicker({
  date,
  slots,
  reservedSlotStart,
  busy = false,
  changingTime = false,
  onSelect,
  onChangeDate,
}: {
  date: string;
  slots: Slot[];
  /** The slot this booking attempt currently holds, if any. */
  reservedSlotStart?: string | null;
  /** True while a reservation is being acquired. */
  busy?: boolean;
  /** True when the customer is deliberately browsing alternatives. */
  changingTime?: boolean;
  onSelect: (slot: Slot) => void;
  onChangeDate: () => void;
}) {
  return (
    <section aria-labelledby="choose-time">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="choose-time" className="text-xl font-extrabold text-navy-900">
          {changingTime ? "Choose a different time" : "Choose a time"}
        </h2>
        <button
          type="button"
          onClick={onChangeDate}
          className="text-sm font-bold text-flame-600 underline underline-offset-4"
        >
          Change date
        </button>
      </div>
      <p className="mt-1 text-sm text-navy-600">
        {longDate(date)} · appointments take about {cp12.durationMinutes} minutes
        {busy && " · reserving your slot…"}
      </p>
      {changingTime && (
        <p className="mt-3 rounded-xl bg-navy-50 px-4 py-3 text-sm leading-relaxed text-navy-800">
          Your current reservation stays held while you look. It is only given
          up once a new time is successfully reserved.
        </p>
      )}

      {slots.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-navy-100 bg-navy-50 p-6">
          <p className="text-sm font-semibold text-navy-900">
            No times left on this date.
          </p>
          <button
            type="button"
            onClick={onChangeDate}
            className="mt-4 rounded-xl bg-flame-500 px-6 py-3 text-sm font-bold text-white hover:bg-flame-600"
          >
            Pick another date
          </button>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {slots.map((slot) => {
            const isReserved = reservedSlotStart === slot.startIso;
            return (
              <button
                key={slot.startIso}
                type="button"
                onClick={() => onSelect(slot)}
                disabled={busy || isReserved}
                aria-pressed={isReserved}
                className={[
                  "flex min-h-14 flex-col items-center justify-center rounded-xl border-2 text-base font-bold transition disabled:cursor-default",
                  isReserved
                    ? "border-trust-600 bg-trust-50 text-navy-900"
                    : "border-navy-200 bg-white text-navy-900 hover:border-flame-500 hover:bg-flame-500 hover:text-white disabled:opacity-50",
                ].join(" ")}
              >
                {slot.label}
                {isReserved && (
                  <span className="mt-0.5 text-[11px] font-bold uppercase tracking-wide text-trust-600">
                    Reserved for you
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
