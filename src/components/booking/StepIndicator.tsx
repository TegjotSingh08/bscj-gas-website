const steps = [
  { number: 1 as const, label: "Date" },
  { number: 2 as const, label: "Time" },
  { number: 3 as const, label: "Details" },
  { number: 4 as const, label: "Confirm" },
];

/**
 * Where the customer is in the booking.
 *
 * Mobile gets a compact numbered row; from `sm` up it keeps the fuller boxed
 * form. The four stacked "STEP n / Label" tiles used 49px and a lot of width
 * on a phone, for information worth about a line.
 *
 * Purely presentational — which steps are reachable, and what happens when one
 * is pressed, is unchanged. Navigation never disturbs a reservation.
 */
export function StepIndicator({
  current,
  onGoTo,
}: {
  current: 1 | 2 | 3 | 4;
  onGoTo: (step: 1 | 2 | 3 | 4) => void;
}) {
  return (
    <ol className="flex items-center gap-1 sm:gap-3">
      {steps.map((step) => {
        const state =
          step.number === current
            ? "current"
            : step.number < current
              ? "done"
              : "upcoming";

        return (
          // `min-w-0` matters: a flex item defaults to min-width:auto and so
          // refuses to shrink below its content, which pushed "Confirm" past
          // the right edge at 320px however narrow the row got.
          <li key={step.number} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              onClick={() => state === "done" && onGoTo(step.number)}
              disabled={state !== "done"}
              aria-current={state === "current" ? "step" : undefined}
              className={[
                "flex min-h-11 w-full min-w-0 items-center justify-center gap-1 rounded-lg border-2 px-1 text-center transition sm:gap-1.5",
                "sm:min-h-0 sm:flex-col sm:gap-0.5 sm:rounded-xl sm:py-1.5",
                state === "current"
                  ? "border-flame-500 bg-flame-500 text-white"
                  : state === "done"
                    ? "border-navy-200 bg-white text-navy-800 hover:border-flame-500"
                    : "border-navy-100 bg-navy-50 text-navy-500",
              ].join(" ")}
            >
              {/*
                No number badge on a phone. Order already conveys position, and
                at 320px the badge cost enough width to truncate "Details" and
                "Confirm" into "Det…" and "Co…". Screen readers still get the
                position from the sr-only text below.
              */}
              <span className="hidden text-[10px] font-bold uppercase tracking-wider opacity-80 sm:inline">
                Step {step.number}
              </span>
              <span className="truncate text-[13px] font-bold sm:text-sm">
                {step.label}
              </span>
              <span className="sr-only sm:hidden">, step {step.number} of 4</span>
              <span className="sr-only">
                {state === "current"
                  ? " (current step)"
                  : state === "done"
                    ? " (completed — go back to this step)"
                    : " (not reached yet)"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
