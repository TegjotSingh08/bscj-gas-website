"use client";

import { useCallback, useEffect, useState } from "react";

import { DatePicker } from "@/components/booking/DatePicker";
import { TimePicker } from "@/components/booking/TimePicker";
import { ReservationBar } from "@/components/booking/ReservationBar";
import type { DayAvailability, Slot } from "@/components/booking/BookingFlow";
import type { Reservation } from "@/lib/booking/attempt";
import { HOLD_WARNING_SECONDS } from "@/lib/booking/holds";
import type { Product, ProductId } from "@/lib/booking/products";

/**
 * The tenant's picker.
 *
 * A **recomposition** of the existing booking components, not a second
 * scheduler: the same `DatePicker`, `TimePicker` and `ReservationBar`, the same
 * `/api/availability` and `/api/hold` endpoints, the same 30-minute holds and
 * the same atomic switch when a time is changed. Nothing about availability,
 * buffers, notice periods or the daily cap is reimplemented here — the one
 * thing this flow adds is that the appointment attaches to a job the tenant
 * was invited to, rather than to a form they filled in.
 *
 * What is deliberately missing compared with the consumer flow: any price, any
 * address entry, any service choice, any customer details, and any way out of
 * this page into the rest of the site. The tenant picks a time. That is the
 * whole permission.
 */

type ConfirmOutcome =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "error"; message: string };

async function loadAvailability(
  productId: ProductId,
  own: Reservation | null,
): Promise<DayAvailability[] | null> {
  const headers: Record<string, string> = {};
  // The caller's own hold, in headers rather than the query string, so a token
  // never reaches a log or browser history.
  if (own?.token) {
    headers["x-hold-slot"] = own.slotStart;
    headers["x-hold-token"] = own.token;
  }

  try {
    const response = await fetch(
      `/api/availability?product=${encodeURIComponent(productId)}`,
      { headers, cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { days?: DayAvailability[] };
    return data.days ?? null;
  } catch {
    return null;
  }
}

export function TenantScheduler({
  product,
  existingStart,
}: {
  product: Product;
  /** Set when the tenant has already chosen, and is changing their mind. */
  existingStart: string | null;
}) {
  const [days, setDays] = useState<DayAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [changingTime, setChangingTime] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ConfirmOutcome>({ kind: "idle" });

  /*
    State is set only after the fetch resolves. Setting it synchronously would
    make the mount effect cascade a second render before it had anything new
    to show.
  */
  const refresh = useCallback(
    async (own: Reservation | null) => {
      const result = await loadAvailability(product.id, own);
      setDays(result ?? []);
      setUnavailable(result === null);
      setLoading(false);
    },
    [product.id],
  );

  useEffect(() => {
    void refresh(null);
  }, [refresh]);

  const availableDates = days
    .filter((day) => day.slots.length > 0)
    .map((day) => day.date);

  const slotsForDate =
    days.find((day) => day.date === selectedDate)?.slots ?? [];

  async function reserve(slot: Slot) {
    setHoldPending(true);
    setNotice(null);
    setOutcome({ kind: "idle" });

    try {
      const response = await fetch("/api/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotStart: slot.startIso,
          productId: product.id,
          /*
            The hold this attempt already owns, so the switch is atomic: the
            replacement is acquired before the old one is given back, and a
            slot lost to somebody else costs the tenant nothing.
          */
          previous: reservation?.token
            ? { slotStart: reservation.slotStart, token: reservation.token, productId: product.id }
            : undefined,
        }),
      });

      const data = (await response.json()) as {
        token?: string;
        expiresAt?: string;
        message?: string;
      };

      if (response.status === 409) {
        setNotice(
          reservation
            ? "That time has just been taken. Your original reservation is still held."
            : "Sorry — that time has just been taken. Please choose another.",
        );
        await refresh(reservation);
        return;
      }

      if (!response.ok) {
        setNotice("We could not reserve that time. Please try another.");
        return;
      }

      setReservation({
        token: data.token ?? null,
        productId: product.id,
        slotStart: slot.startIso,
        slotEnd: slot.endIso,
        label: slot.label,
        dateIso: selectedDate ?? slot.startIso.slice(0, 10),
        expiresAt: data.expiresAt ?? null,
        degraded: !data.token,
      });
      setChangingTime(false);
    } finally {
      setHoldPending(false);
    }
  }

  async function confirm() {
    if (!reservation) return;
    setOutcome({ kind: "working" });

    try {
      const response = await fetch("/api/schedule/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The job is not sent. It comes from the signed session.
        body: JSON.stringify({
          slotStart: reservation.slotStart,
          holdToken: reservation.token,
        }),
      });

      const data = (await response.json()) as { ok?: boolean; message?: string };

      if (response.ok && data.ok) {
        window.location.assign("/schedule/confirmed");
        return;
      }

      setOutcome({
        kind: "error",
        message:
          data.message ??
          "We could not confirm that appointment. Please choose another time.",
      });
      await refresh(null);
      setReservation(null);
    } catch {
      setOutcome({
        kind: "error",
        message: "Something went wrong. Please try again.",
      });
    }
  }

  function releaseAndReset() {
    if (reservation?.token) {
      void fetch("/api/hold/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotStart: reservation.slotStart,
          token: reservation.token,
          productId: product.id,
        }),
      });
    }
    setReservation(null);
    setChangingTime(false);
    void refresh(null);
  }

  if (unavailable) {
    return (
      <p className="mt-6 rounded-xl border-2 border-navy-200 bg-white px-4 py-4 text-sm text-navy-700">
        We cannot load available times at the moment. Please try again shortly,
        or call us and we will book it for you.
      </p>
    );
  }

  return (
    <div className="mt-6">
      {existingStart && !reservation && (
        <p className="mb-4 rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-sm text-navy-700">
          You already have an appointment booked. Choosing a new time will
          replace it.
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="mb-4 rounded-xl border-2 border-navy-200 bg-white px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {notice}
        </p>
      )}

      {outcome.kind === "error" && (
        <p
          role="alert"
          className="mb-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {outcome.message}
        </p>
      )}

      {reservation && (
        <ReservationBar
          reservation={reservation}
          warningSeconds={HOLD_WARNING_SECONDS}
          changingTime={changingTime}
          onChangeTime={() => setChangingTime(true)}
          onKeepTime={() => setChangingTime(false)}
          onCancelBooking={releaseAndReset}
          onExpired={() => {
            setReservation(null);
            setNotice("Your reservation expired. Please choose a time again.");
            void refresh(null);
          }}
        />
      )}

      {(!reservation || changingTime) && (
        <>
          {!selectedDate ? (
            <DatePicker
              loading={loading}
              days={days}
              availableDates={availableDates}
              selectedDate={selectedDate}
              changingTime={changingTime}
              onSelect={setSelectedDate}
            />
          ) : (
            <TimePicker
              date={selectedDate}
              product={product}
              slots={slotsForDate}
              reservedSlotStart={reservation?.slotStart ?? null}
              busy={holdPending}
              changingTime={changingTime}
              onSelect={(slot) => void reserve(slot)}
              onChangeDate={() => setSelectedDate(null)}
            />
          )}
        </>
      )}

      {reservation && !changingTime && (
        <div className="mt-6 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">
            Confirm your appointment
          </h2>
          <p className="mt-2 text-sm text-navy-700">
            {longDate(reservation.dateIso)} at {reservation.label}. The engineer
            will need access for about {product.durationMinutes} minutes.
          </p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={outcome.kind === "working"}
            className="mt-4 w-full rounded-xl bg-flame-500 px-6 py-4 text-base font-bold text-white hover:bg-flame-600 disabled:opacity-60"
          >
            {outcome.kind === "working"
              ? "Confirming…"
              : "Confirm this appointment"}
          </button>
        </div>
      )}
    </div>
  );
}

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
