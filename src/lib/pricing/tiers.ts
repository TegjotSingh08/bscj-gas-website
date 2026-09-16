/**
 * Volume tiers.
 *
 * A tier is a band of committed monthly jobs. Which band an organisation is in
 * is decided **in advance**, from the volume they commit to for the month, not
 * from what they end up doing. That is a deliberate commercial choice: a price
 * that is only knowable at month end cannot be quoted before a job is
 * submitted, cannot be invoiced promptly, and cannot be explained to an agent
 * who asks what a job will cost.
 *
 * **No price appears in this file.** Bands are structure; prices are data, on
 * `pricing_agreement_line`, per service and per band. A price here would be
 * the hard-coding the whole design exists to avoid.
 *
 * Bands are stored on each agreement line as bounds rather than as a named
 * label, so the structure below can change without a migration and without
 * re-labelling agreements signed under the old one.
 *
 * Pure and dependency-free.
 */

/** A band of committed monthly jobs. `maxJobs` null means "and above". */
export type VolumeTier = { minJobs: number; maxJobs: number | null };

/**
 * The band structure BSCJ intends to start from, confirmed 16 September 2026.
 *
 * A default for the admin interface to offer, not a rule the resolver depends
 * on — an agreement may define any bands it likes, and the resolver reads the
 * bounds on the lines it is given.
 */
export const DEFAULT_VOLUME_TIERS: readonly VolumeTier[] = [
  { minJobs: 1, maxJobs: 14 },
  { minJobs: 15, maxJobs: 29 },
  { minJobs: 30, maxJobs: 44 },
  { minJobs: 45, maxJobs: 59 },
  { minJobs: 60, maxJobs: 74 },
  { minJobs: 75, maxJobs: 99 },
  { minJobs: 100, maxJobs: null },
];

/** Whether a committed volume falls inside a band. Bounds are inclusive. */
export function tierContains(tier: VolumeTier, committedJobs: number): boolean {
  if (committedJobs < tier.minJobs) return false;
  return tier.maxJobs === null || committedJobs <= tier.maxJobs;
}

/**
 * The band a committed volume falls in, or null when none covers it.
 *
 * Null is a real answer, not an error to paper over: a commitment of zero
 * matches no band in the default structure, and the caller should charge list
 * rather than guess a tier.
 */
export function tierFor(
  committedJobs: number,
  tiers: readonly VolumeTier[] = DEFAULT_VOLUME_TIERS,
): VolumeTier | null {
  return tiers.find((tier) => tierContains(tier, committedJobs)) ?? null;
}

/**
 * Checks a set of bands for gaps and overlaps.
 *
 * Two bands that both match a volume make the price ambiguous, and a gap makes
 * it unresolvable. Both are configuration mistakes that would otherwise only
 * show up as a surprising invoice, so an agreement is validated when it is
 * saved rather than when it is charged.
 */
export type TierProblem =
  | { kind: "overlap"; first: VolumeTier; second: VolumeTier }
  | { kind: "gap"; after: VolumeTier; before: VolumeTier }
  | { kind: "invalid"; tier: VolumeTier };

export function validateTiers(tiers: readonly VolumeTier[]): TierProblem[] {
  const problems: TierProblem[] = [];

  for (const tier of tiers) {
    if (
      !Number.isInteger(tier.minJobs) ||
      tier.minJobs < 0 ||
      (tier.maxJobs !== null &&
        (!Number.isInteger(tier.maxJobs) || tier.maxJobs < tier.minJobs))
    ) {
      problems.push({ kind: "invalid", tier });
    }
  }

  const sorted = [...tiers].sort((a, b) => a.minJobs - b.minJobs);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (current.maxJobs === null) {
      // An open-ended band swallows everything after it.
      problems.push({ kind: "overlap", first: current, second: next });
      continue;
    }
    if (next.minJobs <= current.maxJobs) {
      problems.push({ kind: "overlap", first: current, second: next });
    } else if (next.minJobs > current.maxJobs + 1) {
      problems.push({ kind: "gap", after: current, before: next });
    }
  }

  return problems;
}

/** "15–29 jobs" / "100+ jobs". For an admin screen, never for a public page. */
export function describeTier(tier: VolumeTier): string {
  return tier.maxJobs === null
    ? `${tier.minJobs}+ jobs`
    : `${tier.minJobs}–${tier.maxJobs} jobs`;
}
