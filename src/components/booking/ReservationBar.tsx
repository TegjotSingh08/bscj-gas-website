"use client";

import { useEffect, useState } from "react";

import type { Reservation } from "@/lib/booking/attempt";

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function endLabel(slotEnd: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  }).format(new Date(slotEnd));
}

/**
 * The customer's active reservation, shown for the whole booking attempt.
 *
 * The countdown is display only — it is derived from the server's expiry time
 * on every tick rather than counted down locally, so moving between steps or
 * re-rendering cannot reset it. Redis holds the authoritative TTL.
 */
export function ReservationBar({
  reservation,
  warningSeconds,
  changingTime,
  onChangeTime,
  onKeepTime,
  onCancelBooking,
  onExpired,
}: {
  reservation: Reservation;
  warningSeconds: number;
  changingTime: boolean;
  onChangeTime: () => void;
  onKeepTime: () => void;
  onCancelBooking: () => void;
  onExpired: () => void;
}) {
  const { expiresAt } = reservation;

  const [secondsLeft, setSecondsLeft] = useState(() =>
    expiresAt
      ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000))
      : null,
  );

  useEffect(() => {
    // Degraded mode has no TTL to count down, so there is nothing to tick.
    if (!expiresAt) return;

    const tick = () => {
      const remaining = Math.max(
        0,
        Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) onExpired();
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, onExpired]);

  const showCountdown = expiresAt !== null && secondsLeft !== null;
  const isEndingSoon = showCountdown && secondsLeft <= warningSeconds;
  const minutes = secondsLeft === null ? 0 : Math.floor(secondsLeft / 60);
  const seconds = secondsLeft === null ? 0 : secondsLeft % 60;

  return (
    <section
      aria-labelledby="reservation-heading"
      className={[
        "mt-6 rounded-2xl border-2 p-4 sm:p-5",
        isEndingSoon
          ? "border-flame-500 bg-flame-400/15"
          : "border-trust-600 bg-trust-50",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="reservation-heading"
            className="text-sm font-bold uppercase tracking-wide text-navy-700"
          >
            Your appointment is reserved
          </h2>
          <p className="mt-1 text-lg font-extrabold text-navy-900">
            {longDate(reservation.dateIso)}
          </p>
          <p className="text-base font-bold text-navy-800">
            {reservation.label}–{endLabel(reservation.slotEnd)}
          </p>
        </div>

        {showCountdown && (
          <p
            aria-live="polite"
            aria-atomic="true"
            className={[
              "text-base font-extrabold tabular-nums",
              isEndingSoon ? "text-flame-600" : "text-trust-600",
            ].join(" ")}
          >
            <span aria-hidden="true">
              {minutes}:{String(seconds).padStart(2, "0")} remaining
            </span>
            <span className="sr-only">
              {minutes > 0
                ? `${minutes} minute${minutes === 1 ? "" : "s"} remaining on your reservation`
                : "Less than a minute remaining on your reservation"}
            </span>
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {changingTime ? (
          <button
            type="button"
            onClick={onKeepTime}
            data-analytics-id="reservation-keep-time"
            className="min-h-11 rounded-lg bg-navy-800 px-4 text-sm font-bold text-white hover:bg-navy-900"
          >
            Keep this time
          </button>
        ) : (
          <button
            type="button"
            onClick={onChangeTime}
            data-analytics-id="reservation-change-time"
            className="min-h-11 rounded-lg border-2 border-navy-300 bg-white px-4 text-sm font-bold text-navy-900 hover:border-flame-500"
          >
            Change time
          </button>
        )}

        <button
          type="button"
          onClick={onCancelBooking}
          data-analytics-id="reservation-cancel"
          className="min-h-11 rounded-lg px-4 text-sm font-bold text-navy-700 underline underline-offset-4 hover:text-flame-600"
        >
          Cancel booking
        </button>
      </div>

      {reservation.degraded && (
        <p className="mt-3 text-xs leading-relaxed text-navy-700">
          We could not hold this time exclusively just now, so please confirm
          soon — the appointment goes to whoever confirms first.
        </p>
      )}
    </section>
  );
}
