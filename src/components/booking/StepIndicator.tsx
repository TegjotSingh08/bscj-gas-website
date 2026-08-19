const steps = [
  { number: 1 as const, label: "Date" },
  { number: 2 as const, label: "Time" },
  { number: 3 as const, label: "Details" },
  { number: 4 as const, label: "Confirm" },
];

export function StepIndicator({
  current,
  onGoTo,
}: {
  current: 1 | 2 | 3 | 4;
  onGoTo: (step: 1 | 2 | 3 | 4) => void;
}) {
  return (
    <ol className="flex items-center gap-1.5 sm:gap-3">
      {steps.map((step) => {
        const state =
          step.number === current
            ? "current"
            : step.number < current
              ? "done"
              : "upcoming";

        return (
          <li key={step.number} className="flex flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={() => state === "done" && onGoTo(step.number)}
              disabled={state !== "done"}
              aria-current={state === "current" ? "step" : undefined}
              className={[
                "flex min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-1 py-1.5 text-center transition",
                state === "current"
                  ? "border-flame-500 bg-flame-500 text-white"
                  : state === "done"
                    ? "border-navy-200 bg-white text-navy-800 hover:border-flame-500"
                    : "border-navy-100 bg-navy-50 text-navy-500",
              ].join(" ")}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">
                Step {step.number}
              </span>
              <span className="text-xs font-bold sm:text-sm">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
