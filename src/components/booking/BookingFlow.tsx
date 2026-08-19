"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { business, calendarDirectUrl, cp12 } from "@/lib/business";
import { customerTypeLabels, customerTypes } from "@/lib/booking/schema";
import { DatePicker } from "./DatePicker";
import { TimePicker } from "./TimePicker";
import { DetailsForm, type DetailsValues } from "./DetailsForm";
import { ReviewStep } from "./ReviewStep";
import { Confirmation, type ConfirmedBooking } from "./Confirmation";
import { StepIndicator } from "./StepIndicator";
import { BookingFallback } from "./BookingFallback";

export type Slot = { startIso: string; endIso: string; label: string };
export type DayAvailability = { date: string; slots: Slot[] };

type LoadState = "loading" | "ready" | "failed";

/** Pure fetcher: no React state, so it can live outside the component. */
async function fetchAvailability(): Promise<DayAvailability[] | null> {
  try {
    const response = await fetch("/api/availability", { cache: "no-store" });
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
  propertyAddress: "",
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
 * Availability comes from the engineer's Google Calendar via our own API, so
 * the customer never sees a Google interface and never signs in anywhere.
 */
export function BookingFlow() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [days, setDays] = useState<DayAvailability[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [details, setDetails] = useState<DetailsValues>(emptyDetails);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<ConfirmedBooking | null>(null);

  /**
   * Bring each new step into view. Without this the customer can advance a
   * step while looking at the middle of the previous one — especially on a
   * phone, where the next step renders below the fold.
   */
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
  }, [step, confirmed]);

  /**
   * One key per booking attempt, so a double click cannot double-book.
   * Created on first confirm — never during render, which must stay pure.
   */
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

  /** Re-reads availability from a handler — after a retry, or a lost slot. */
  const refreshAvailability = useCallback(async () => {
    setLoadState("loading");
    const result = await fetchAvailability();
    if (result) {
      setDays(result);
      setLoadState("ready");
    } else {
      setLoadState("failed");
    }
  }, []);

  const availableDays = useMemo(
    () => days.filter((day) => day.slots.length > 0),
    [days],
  );

  const slotsForSelectedDate = useMemo(() => {
    if (!selectedDate) return [];
    return days.find((day) => day.date === selectedDate)?.slots ?? [];
  }, [days, selectedDate]);

  function handleSelectDate(date: string) {
    setSelectedDate(date);
    setSelectedSlot(null);
    setStep(2);
  }

  function handleSelectSlot(slot: Slot) {
    setSelectedSlot(slot);
    setStep(3);
  }

  async function handleConfirm() {
    if (!selectedSlot) return;
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const response = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...details,
          slotStart: selectedSlot.startIso,
          idempotencyKey: ensureIdempotencyKey(),
        }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        setConfirmed(data.booking as ConfirmedBooking);
        return;
      }

      if (data.error === "slot_taken") {
        setFormError(data.message);
        setSelectedSlot(null);
        setStep(2);
        await refreshAvailability();
        return;
      }

      if (data.error === "validation_failed") {
        setFieldErrors(data.fieldErrors ?? {});
        setFormError("Please check the highlighted details.");
        setStep(3);
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
        <BookingFallback onRetry={() => void refreshAvailability()} />
      </div>
    );
  }

  return (
    <div ref={flowTop} className="scroll-mt-24">
      <StepIndicator
        current={step}
        onGoTo={(target) => {
          if (target < step) setStep(target);
        }}
      />

      {formError && (
        <p
          role="alert"
          className="mt-6 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
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
            onSelect={handleSelectDate}
          />
        )}

        {step === 2 && selectedDate && (
          <TimePicker
            date={selectedDate}
            slots={slotsForSelectedDate}
            selected={selectedSlot}
            onSelect={handleSelectSlot}
            onChangeDate={() => setStep(1)}
          />
        )}

        {step === 3 && selectedSlot && selectedDate && (
          <DetailsForm
            values={details}
            fieldErrors={fieldErrors}
            onChange={setDetails}
            onBack={() => setStep(2)}
            onContinue={() => {
              setFieldErrors({});
              setFormError(null);
              setStep(4);
            }}
          />
        )}

        {step === 4 && selectedSlot && selectedDate && (
          <ReviewStep
            date={selectedDate}
            slot={selectedSlot}
            details={details}
            submitting={submitting}
            onBack={() => setStep(3)}
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

export { customerTypeLabels, customerTypes };
