"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { business, calendarDirectUrl, cp12 } from "@/lib/business";
import {
  attemptReducer,
  initialAttemptState,
  previousHoldFor,
  type Reservation,
  type Step,
} from "@/lib/booking/attempt";
import { DatePicker } from "./DatePicker";
import { TimePicker } from "./TimePicker";
import { DetailsForm, type DetailsValues } from "./DetailsForm";
import { ReviewStep } from "./ReviewStep";
import { Confirmation, type ConfirmedBooking } from "./Confirmation";
import { StepIndicator } from "./StepIndicator";
import { BookingFallback } from "./BookingFallback";
import { ReservationBar } from "./ReservationBar";

export type Slot = { startIso: string; endIso: string; label: string };
export type DayAvailability = { date: string; slots: Slot[] };

type LoadState = "loading" | "ready" | "failed";

/** Mirrors HOLD_WARNING_SECONDS on the server. */
const HOLD_WARNING_SECONDS = 300;

/** Pure fetcher: no React state, so it can live outside the component. */
async function fetchAvailability(
  reservation?: Reservation | null,
): Promise<DayAvailability[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (reservation?.token) {
      headers["x-hold-slot"] = reservation.slotStart;
      headers["x-hold-token"] = reservation.token;
    }
    const response = await fetch("/api/availability", {
      cache: "no-store",
      headers,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { days?: DayAvailability[] };
    return data.days ?? [];
  } catch {
    return null;
  }
}

const emptyDetails: DetailsValues = {
  fullName: "",
  email: "",
  phone: "",
  houseOrName: "",
  street: "",
  town: "",
  postcode: "",
  customerType: "landlord",
  applianceCount: 3,
  tenantName: "",
  tenantPhone: "",
  accessNotes: "",
  company: "",
};

/**
 * Four-step booking flow: date, time, details, review.
 *
 * The reservation belongs to the booking attempt, not to a step, so moving
 * backwards and forwards never disturbs it. Changing the reserved time is a
 * deliberate action, and the replacement is always secured before the original
 * is given up.
 */
export function BookingFlow() {
  const [attempt, dispatch] = useReducer(attemptReducer, initialAttemptState);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [days, setDays] = useState<DayAvailability[]>([]);
  const [details, setDetails] = useState<DetailsValues>(emptyDetails);
  const [submitting, setSubmitting] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<ConfirmedBooking | null>(null);
  /** Ticked on the review step. Never carried over from a previous attempt. */
  const [addressConfirmed, setAddressConfirmed] = useState(false);

  const { step, reservation, changingTime, selectedDate } = attempt;

  /**
   * Mirrors the live reservation for the abandonment handler below, which is
   * registered once and must not be re-registered whenever it changes.
   */
  const reservationRef = useRef<Reservation | null>(null);
  useEffect(() => {
    reservationRef.current = reservation;
  }, [reservation]);

  /**
   * Best-effort release if the customer really leaves the page.
   *
   * Registered on mount only, so it cannot fire on a re-render, a step change,
   * or Strict Mode's development double-invoke — none of which mean the
   * customer has gone. Correctness never depends on this: the 30 minute TTL is
   * the authoritative cleanup.
   */
  useEffect(() => {
    const release = () => {
      const current = reservationRef.current;
      if (!current?.token) return;
      navigator.sendBeacon?.(
        "/api/hold/release",
        new Blob(
          [
            JSON.stringify({
              slotStart: current.slotStart,
              token: current.token,
            }),
          ],
          { type: "application/json" },
        ),
      );
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);

  const flowTop = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = flowTop.current;
    if (!target) return;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [step, changingTime, confirmed]);

  const idempotencyKey = useRef<string | null>(null);
  function ensureIdempotencyKey(): string {
    if (!idempotencyKey.current) {
      idempotencyKey.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
    }
    return idempotencyKey.current;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchAvailability();
      if (cancelled) return;
      if (result) {
        setDays(result);
        setLoadState("ready");
      } else {
        setLoadState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAvailability = useCallback(
    async (current?: Reservation | null) => {
      setLoadState("loading");
      const result = await fetchAvailability(current);
      if (result) {
        setDays(result);
        setLoadState("ready");
      } else {
        setLoadState("failed");
      }
    },
    [],
  );

  const availableDays = useMemo(
    () => days.filter((day) => day.slots.length > 0),
    [days],
  );

  const slotsForSelectedDate = useMemo(() => {
    if (!selectedDate) return [];
    return days.find((day) => day.date === selectedDate)?.slots ?? [];
  }, [days, selectedDate]);

  /**
   * Reserves a slot. The current reservation travels with the request so the
   * server can release it — but only once the replacement is safely taken, so
   * a slot lost to someone else never costs the customer what they already had.
   */
  async function reserveSlot(slot: Slot) {
    setHoldPending(true);
    setFormError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotStart: slot.startIso,
          previous: previousHoldFor(attempt),
        }),
      });

      const data = await response.json();

      if (response.status === 409) {
        if (reservation) {
          setNotice(
            "That appointment has just been taken. Your original reservation is still held.",
          );
        } else {
          setFormError(
            data.message ??
              "Sorry — that appointment is no longer available. Please choose another time.",
          );
        }
        await refreshAvailability(reservation);
        return;
      }

      if (!response.ok) {
        setFormError(
          "We could not reserve that appointment. Please try another time, or call or WhatsApp us.",
        );
        return;
      }

      dispatch({
        type: "reserved",
        reservation: {
          token: data.token ?? null,
          slotStart: slot.startIso,
          slotEnd: slot.endIso,
          label: slot.label,
          dateIso: selectedDate ?? slot.startIso.slice(0, 10),
          expiresAt: data.expiresAt ?? null,
          degraded: Boolean(data.degraded),
        },
      });
    } catch {
      setFormError(
        "We could not reach our booking system. Please call or WhatsApp us and we will book you in.",
      );
    } finally {
      setHoldPending(false);
    }
  }

  const handleExpired = useCallback(async () => {
    dispatch({ type: "expired" });
    setNotice(null);
    setFormError(
      "Your reserved appointment has expired. Please choose another available time.",
    );
    await refreshAvailability(null);
  }, [refreshAvailability]);

  async function handleCancelBooking() {
    const confirmedCancel = window.confirm(
      "Cancel this booking and release your reserved appointment?",
    );
    if (!confirmedCancel) return;

    const current = reservation;
    dispatch({ type: "cancel-booking" });
    setDetails(emptyDetails);
    setAddressConfirmed(false);
    setFormError(null);
    setNotice(null);
    setFieldErrors({});
    idempotencyKey.current = null;

    if (current?.token) {
      try {
        await fetch("/api/hold", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slotStart: current.slotStart,
            token: current.token,
          }),
        });
      } catch {
        // The TTL clears it regardless.
      }
    }
    await refreshAvailability(null);
  }

  async function handleConfirm() {
    if (!reservation) return;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    setFieldErrors({});

    try {
      const response = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...details,
          addressConfirmedByCustomer: addressConfirmed,
          slotStart: reservation.slotStart,
          holdToken: reservation.token ?? undefined,
          idempotencyKey: ensureIdempotencyKey(),
        }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        setConfirmed(data.booking as ConfirmedBooking);
        return;
      }

      if (data.error === "hold_expired") {
        await handleExpired();
        return;
      }

      if (data.error === "slot_taken") {
        dispatch({ type: "expired" });
        setFormError(data.message);
        await refreshAvailability(null);
        return;
      }

      if (data.error === "validation_failed") {
        setFieldErrors(data.fieldErrors ?? {});
        setFormError("Please check the highlighted details.");
        dispatch({ type: "go-to-step", step: 3 });
        return;
      }

      if (data.error === "duplicate") {
        setFormError(data.message);
        return;
      }

      setFormError(
        "We could not complete the booking just now. Please call or WhatsApp us and we will book you in.",
      );
    } catch {
      setFormError(
        "We could not reach our booking system. Please call or WhatsApp us and we will book you in.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return (
      <div ref={flowTop} className="scroll-mt-24">
        <Confirmation booking={confirmed} />
      </div>
    );
  }

  if (loadState === "failed") {
    return (
      <div ref={flowTop} className="scroll-mt-24">
        <BookingFallback onRetry={() => void refreshAvailability(reservation)} />
      </div>
    );
  }

  return (
    <div ref={flowTop} className="scroll-mt-24">
      <StepIndicator
        current={step}
        onGoTo={(target: Step) => {
          if (target < step) dispatch({ type: "go-to-step", step: target });
        }}
      />

      {/*
        Shown for every step a reservation can exist on, the date step
        included: browsing for another date has to keep the held appointment,
        its countdown and the "Keep this time" escape in front of the customer.
      */}
      {reservation && (
        <ReservationBar
          reservation={reservation}
          warningSeconds={HOLD_WARNING_SECONDS}
          changingTime={changingTime}
          onChangeTime={() => dispatch({ type: "start-change-time" })}
          onKeepTime={() => dispatch({ type: "cancel-change-time" })}
          onCancelBooking={() => void handleCancelBooking()}
          onExpired={() => void handleExpired()}
        />
      )}

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl border-2 border-navy-300 bg-navy-50 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {notice}
        </p>
      )}

      {formError && (
        <p
          role="alert"
          className="mt-4 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
        >
          {formError}
        </p>
      )}

      <div className="mt-6">
        {step === 1 && (
          <DatePicker
            loading={loadState === "loading"}
            days={days}
            availableDates={availableDays.map((day) => day.date)}
            selectedDate={selectedDate}
            changingTime={changingTime}
            onSelect={(date) => dispatch({ type: "select-date", date })}
          />
        )}

        {step === 2 && selectedDate && (
          <TimePicker
            date={selectedDate}
            slots={slotsForSelectedDate}
            reservedSlotStart={reservation?.slotStart ?? null}
            busy={holdPending}
            changingTime={changingTime}
            onSelect={(slot) => void reserveSlot(slot)}
            onChangeDate={() => dispatch({ type: "go-to-step", step: 1 })}
          />
        )}

        {step === 3 && reservation && (
          <DetailsForm
            values={details}
            fieldErrors={fieldErrors}
            onPatch={(patch) => {
              // Any edit invalidates a confirmation given on the review step.
              setAddressConfirmed(false);
              setDetails((previous) => ({ ...previous, ...patch }));
            }}
            onBack={() => dispatch({ type: "go-to-step", step: 2 })}
            onContinue={() => {
              setFieldErrors({});
              setFormError(null);
              dispatch({ type: "go-to-step", step: 4 });
            }}
          />
        )}

        {step === 4 && reservation && (
          <ReviewStep
            date={reservation.dateIso}
            slot={{
              startIso: reservation.slotStart,
              endIso: reservation.slotEnd,
              label: reservation.label,
            }}
            details={details}
            submitting={submitting}
            addressConfirmed={addressConfirmed}
            onAddressConfirmedChange={setAddressConfirmed}
            onBack={() => dispatch({ type: "go-to-step", step: 3 })}
            onConfirm={handleConfirm}
          />
        )}
      </div>

      <p className="mt-8 text-center text-xs leading-relaxed text-navy-600">
        Prefer to talk to someone?{" "}
        <a
          href={business.phoneHref}
          data-analytics-id="bookflow-call"
          className="font-bold text-flame-600 underline underline-offset-4"
        >
          Call {business.phoneDisplay}
        </a>{" "}
        or{" "}
        <a
          href={business.whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="bookflow-whatsapp"
          className="font-bold text-flame-600 underline underline-offset-4"
        >
          message us on WhatsApp
        </a>
        . {cp12.payment} — nothing is taken now.
      </p>
      <p className="mt-2 text-center text-xs text-navy-500">
        <a
          href={calendarDirectUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-id="bookflow-alternative"
          className="underline underline-offset-4 hover:text-navy-800"
        >
          Alternative booking page
        </a>
      </p>
    </div>
  );
}
