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
import { bookingConfig } from "@/lib/booking/config";
import {
  DEFAULT_PRODUCT_ID,
  productFor,
  type ProductId,
} from "@/lib/booking/products";
import {
  requiresEarlyPerformanceRequest,
  TERMS_VERSION,
} from "@/lib/booking/terms";
import {
  attemptReducer,
  initialAttemptState,
  previousHoldFor,
  type Reservation,
  type Step,
} from "@/lib/booking/attempt";
import { ServiceChoice } from "./ServiceChoice";
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

const BOOKING_TIME_ZONE = bookingConfig.timeZone;

/**
 * Pure fetcher: no React state, so it can live outside the component.
 *
 * The product is part of the question, not a detail: the two services are
 * different lengths, so they rule out different times.
 */
async function fetchAvailability(
  productId: ProductId,
  reservation?: Reservation | null,
): Promise<DayAvailability[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (reservation?.token) {
      headers["x-hold-slot"] = reservation.slotStart;
      headers["x-hold-token"] = reservation.token;
    }
    const response = await fetch(
      `/api/availability?product=${encodeURIComponent(productId)}`,
      {
        cache: "no-store",
        headers,
      },
    );
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
  /** The service being booked. The CP12 is the default, as it is everywhere. */
  const [productId, setProductId] = useState<ProductId>(DEFAULT_PRODUCT_ID);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [days, setDays] = useState<DayAvailability[]>([]);
  const [details, setDetails] = useState<DetailsValues>(emptyDetails);
  const [submitting, setSubmitting] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<ConfirmedBooking | null>(null);
  /**
   * The review step's confirmations. All three start false, are never carried
   * over from a previous attempt, and are cleared by any edit to the details.
   * The server requires each of them again for itself.
   */
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [earlyPerformanceRequested, setEarlyPerformanceRequested] =
    useState(false);

  const { step, reservation, changingTime, selectedDate } = attempt;
  const product = productFor(productId);

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
              productId: current.productId,
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
      const result = await fetchAvailability(DEFAULT_PRODUCT_ID);
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
    async (forProduct: ProductId, current?: Reservation | null) => {
      setLoadState("loading");
      const result = await fetchAvailability(forProduct, current);
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

  /**
   * Whether this appointment falls inside the statutory cancellation period,
   * and so needs the customer's express request before the engineer attends.
   *
   * Display only — it decides whether to *show* the control. The server
   * recomputes it from the slot and the moment of booking, so a browser that
   * suppresses this cannot make the requirement go away.
   */
  const earlyPerformanceRequired = useMemo(() => {
    if (!reservation) return false;
    return requiresEarlyPerformanceRequest(
      new Date(reservation.slotStart),
      new Date(),
      BOOKING_TIME_ZONE,
    );
  }, [reservation]);

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
          productId,
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
        await refreshAvailability(productId, reservation);
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
          productId,
          slotStart: slot.startIso,
          // The server states when the appointment ends, from the product it
          // actually reserved. The slot's own end is only ever a display hint.
          slotEnd: data.slotEnd ?? slot.endIso,
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
    await refreshAvailability(productId, null);
  }, [refreshAvailability, productId]);

  /** Gives a reservation back, with every start it occupied. Best effort. */
  async function releaseReservation(current: Reservation | null) {
    if (!current?.token) return;
    try {
      await fetch("/api/hold", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotStart: current.slotStart,
          token: current.token,
          productId: current.productId,
        }),
      });
    } catch {
      // The TTL clears it regardless.
    }
  }

  /**
   * Switches service.
   *
   * With no reservation this is just a different question to ask the
   * availability endpoint. With one, the held time has to be re-reserved for
   * the new length before it can be kept — a 45-minute slot is not necessarily
   * free for 60 minutes — so the server is asked, and the answer is honoured:
   * kept if it can be, given up and re-chosen if it cannot.
   *
   * Every consent is cleared either way. They were given against a price and a
   * service that no longer apply, and the obligation-to-pay tick least of all
   * may survive a change of total.
   */
  async function selectProduct(next: ProductId) {
    if (next === productId || holdPending || submitting) return;

    const previousProduct = productId;
    const current = reservation;

    setProductId(next);
    setFormError(null);
    setNotice(null);
    setAddressConfirmed(false);
    setTermsAccepted(false);
    setEarlyPerformanceRequested(false);

    if (!current) {
      await refreshAvailability(next, null);
      return;
    }

    setHoldPending(true);
    try {
      const response = await fetch("/api/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotStart: current.slotStart,
          productId: next,
          previous: previousHoldFor(attempt),
        }),
      });
      const data = await response.json();

      if (response.ok) {
        dispatch({
          type: "reservation-updated",
          reservation: {
            ...current,
            productId: next,
            token: data.token ?? current.token,
            slotEnd: data.slotEnd ?? current.slotEnd,
            expiresAt: data.expiresAt ?? current.expiresAt,
            degraded: Boolean(data.degraded),
          },
        });
        await refreshAvailability(next, {
          ...current,
          productId: next,
          token: data.token ?? current.token,
        });
        return;
      }

      if (response.status === 409) {
        // The time genuinely cannot take the longer appointment. Say so and
        // send them back to choose again, rather than silently keeping a
        // reservation for a service they are no longer buying.
        await releaseReservation(current);
        dispatch({ type: "expired" });
        setNotice(
          `Your reserved time is not available for the ${productFor(next).name}. Please choose another time.`,
        );
        await refreshAvailability(next, null);
        return;
      }

      // Anything else — the calendar unreachable, the store down, a 500 — says
      // nothing about whether the time fits. Giving the reservation up over a
      // transient fault would cost the customer a slot they still hold, so the
      // choice goes back instead and their booking stands untouched.
      setProductId(previousProduct);
      setFormError(
        "We could not change the service just now. Your reserved time is still held. Please try again, or call or WhatsApp us.",
      );
    } catch {
      // The request never completed, so nothing was released. Put the choice
      // back rather than stranding the customer between two services.
      setProductId(previousProduct);
      setFormError(
        "We could not reach our booking system. Your reserved time is still held. Please try again, or call or WhatsApp us.",
      );
    } finally {
      setHoldPending(false);
    }
  }

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

    await releaseReservation(current);
    await refreshAvailability(productId, null);
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
          productId,
          addressConfirmedByCustomer: addressConfirmed,
          termsAccepted,
          termsVersion: TERMS_VERSION,
          earlyPerformanceRequested,
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
        await refreshAvailability(productId, null);
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

      if (data.error === "terms_required") {
        // The server disagreed about what this booking needed — most likely a
        // stale tab holding an older terms version. Clear the confirmations
        // rather than leaving ticks standing for something no longer shown.
        setAddressConfirmed(false);
        setTermsAccepted(false);
        setEarlyPerformanceRequested(false);
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
        <BookingFallback
          onRetry={() => void refreshAvailability(productId, reservation)}
        />
      </div>
    );
  }

  return (
    <div ref={flowTop} className="scroll-mt-24">
      {/*
        Above the step indicator rather than inside the funnel: choosing a
        service is not a fifth step, and someone who only wants the £45
        certificate should reach a date in exactly the same number of taps as
        before. It stays on screen throughout, so the service can be changed
        without unwinding the booking.
      */}
      <div className="mb-6">
        <ServiceChoice
          value={productId}
          onChange={(next) => void selectProduct(next)}
          disabled={holdPending || submitting}
        />
      </div>

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
            product={product}
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
            product={product}
            fieldErrors={fieldErrors}
            onPatch={(patch) => {
              // Any edit invalidates a confirmation given on the review step.
              setAddressConfirmed(false);
              setTermsAccepted(false);
              setEarlyPerformanceRequested(false);
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
            product={product}
            slot={{
              startIso: reservation.slotStart,
              endIso: reservation.slotEnd,
              label: reservation.label,
            }}
            details={details}
            submitting={submitting}
            addressConfirmed={addressConfirmed}
            onAddressConfirmedChange={setAddressConfirmed}
            termsAccepted={termsAccepted}
            onTermsAcceptedChange={setTermsAccepted}
            earlyPerformanceRequired={earlyPerformanceRequired}
            earlyPerformanceRequested={earlyPerformanceRequested}
            onEarlyPerformanceRequestedChange={setEarlyPerformanceRequested}
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
