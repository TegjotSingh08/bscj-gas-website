"use client";

import { useEffect, useState } from "react";

/**
 * Shows how long the customer's reservation has left.
 *
 * Display only. The server's TTL is authoritative — this countdown reaching
 * zero triggers a re-check, it does not itself decide anything.
 */
export function HoldBanner({
  expiresAt,
  warningSeconds,
  onExpired,
}: {
  expiresAt: string;
  warningSeconds: number;
  onExpired: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
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

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const label = `${minutes}:${String(seconds).padStart(2, "0")} remaining`;
  const isEndingSoon = secondsLeft <= warningSeconds;

  return (
    <div
      className={[
        "mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 px-4 py-3",
        isEndingSoon
          ? "border-flame-500 bg-flame-400/15"
          : "border-trust-600 bg-trust-50",
      ].join(" ")}
    >
      <p className="text-sm font-bold text-navy-900">
        This appointment is reserved for you for 30 minutes.
      </p>
      <p
        // Announced every minute rather than every second: a per-second live
        // region would make a screen reader unusable.
        aria-live="polite"
        aria-atomic="true"
        className={[
          "text-sm font-extrabold tabular-nums",
          isEndingSoon ? "text-flame-600" : "text-trust-600",
        ].join(" ")}
      >
        <span aria-hidden="true">{label}</span>
        <span className="sr-only">
          {minutes > 0
            ? `${minutes} minute${minutes === 1 ? "" : "s"} remaining on your reservation`
            : "Less than a minute remaining on your reservation"}
        </span>
      </p>
    </div>
  );
}
