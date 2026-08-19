"use client";

import { useMemo, useState } from "react";

import type { DayAvailability } from "./BookingFlow";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Days in a month, without constructing timezone-sensitive Date objects. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-first index (0 = Monday) of the 1st of the month. */
function firstWeekdayOffset(year: number, month: number): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

function isoFor(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function DatePicker({
  loading,
  days,
  availableDates,
  selectedDate,
  onSelect,
}: {
  loading: boolean;
  days: DayAvailability[];
  availableDates: string[];
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const bookableRange = useMemo(() => days.map((day) => day.date), [days]);
  const firstBookable = bookableRange[0];
  const lastBookable = bookableRange[bookableRange.length - 1];

  const initialMonth = useMemo(() => {
    const source = selectedDate ?? firstBookable;
    if (!source) {
      const now = new Date();
      return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    }
    const [year, month] = source.split("-").map(Number);
    return { year, month };
  }, [selectedDate, firstBookable]);

  const [view, setView] = useState(initialMonth);

  const availableSet = useMemo(() => new Set(availableDates), [availableDates]);
  const slotCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of days) map.set(day.date, day.slots.length);
    return map;
  }, [days]);

  const cells = useMemo(() => {
    const offset = firstWeekdayOffset(view.year, view.month);
    const total = daysInMonth(view.year, view.month);
    const list: (string | null)[] = Array.from({ length: offset }, () => null);
    for (let day = 1; day <= total; day += 1) {
      list.push(isoFor(view.year, view.month, day));
    }
    return list;
  }, [view]);

  const canGoPrevious =
    !!firstBookable &&
    isoFor(view.year, view.month, 1) > firstBookable.slice(0, 8) + "01";
  const canGoNext =
    !!lastBookable &&
    isoFor(view.year, view.month, daysInMonth(view.year, view.month)) <
      lastBookable;

  function shiftMonth(direction: -1 | 1) {
    setView((current) => {
      const month = current.month + direction;
      if (month < 1) return { year: current.year - 1, month: 12 };
      if (month > 12) return { year: current.year + 1, month: 1 };
      return { year: current.year, month };
    });
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-navy-100 bg-white p-6">
        <p className="text-sm font-semibold text-navy-700">
          Loading live availability…
        </p>
        <div className="mt-5 grid grid-cols-7 gap-1.5" aria-hidden="true">
          {Array.from({ length: 28 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-lg bg-navy-50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="choose-date">
      <h2 id="choose-date" className="text-xl font-extrabold text-navy-900">
        Choose a date
      </h2>
      <p className="mt-1 text-sm text-navy-600">
        Dates shown in orange have appointments free.
      </p>

      <div className="mt-4 rounded-2xl border border-navy-100 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            disabled={!canGoPrevious}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-navy-200 text-lg font-bold text-navy-800 disabled:opacity-30"
            aria-label="Previous month"
          >
            ‹
          </button>
          <p
            aria-live="polite"
            className="text-base font-extrabold text-navy-900"
          >
            {monthLabel(view.year, view.month)}
          </p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            disabled={!canGoNext}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-navy-200 text-lg font-bold text-navy-800 disabled:opacity-30"
            aria-label="Next month"
          >
            ›
          </button>
        </div>

        <div className="mt-4 grid grid-cols-7 gap-1 text-center sm:gap-1.5">
          {WEEKDAY_LABELS.map((label) => (
            <span
              key={label}
              className="pb-1 text-[11px] font-bold uppercase tracking-wide text-navy-500"
            >
              {label.slice(0, 1)}
              <span className="sr-only">{label}</span>
            </span>
          ))}

          {cells.map((iso, index) => {
            if (!iso) return <span key={`pad-${index}`} />;

            const dayNumber = Number(iso.slice(-2));
            const isAvailable = availableSet.has(iso);
            const isSelected = iso === selectedDate;
            const count = slotCounts.get(iso) ?? 0;

            return (
              <button
                key={iso}
                type="button"
                disabled={!isAvailable}
                onClick={() => onSelect(iso)}
                aria-label={
                  isAvailable
                    ? `${dayNumber} ${monthLabel(view.year, view.month)}, ${count} appointment${count === 1 ? "" : "s"} available`
                    : `${dayNumber} ${monthLabel(view.year, view.month)}, no availability`
                }
                aria-pressed={isSelected}
                className={[
                  "flex h-12 flex-col items-center justify-center rounded-lg text-sm font-bold transition",
                  isSelected
                    ? "bg-navy-900 text-white"
                    : isAvailable
                      ? "bg-flame-500/10 text-navy-900 ring-1 ring-flame-500 hover:bg-flame-500 hover:text-white"
                      : "text-navy-300",
                ].join(" ")}
              >
                {dayNumber}
                {isAvailable && (
                  <span
                    aria-hidden="true"
                    className={[
                      "mt-0.5 h-1 w-1 rounded-full",
                      isSelected ? "bg-flame-400" : "bg-flame-500",
                    ].join(" ")}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {availableDates.length === 0 && (
        <p className="mt-4 rounded-xl bg-navy-50 px-4 py-3 text-sm leading-relaxed text-navy-800">
          There are no free appointments in the next few weeks. Please call or
          WhatsApp us and we will find you a time.
        </p>
      )}
    </section>
  );
}
