/**
 * Reading a date somebody typed into a spreadsheet.
 *
 * The whole point of this module is the word **ambiguous**. `03/04/2026` is
 * the 3rd of April in Wolverhampton and the 4th of March in Delaware, and a
 * gas safety certificate expiry read a month wrong is a property that looks
 * compliant when it is not — or a landlord chased for a renewal they do not
 * owe. Neither is a rounding error.
 *
 * So the rule is stated rather than guessed:
 *
 * - **`YYYY-MM-DD`** — ISO, and the only form with no ordering question at
 *   all. What the template's example uses.
 * - **`DD/MM/YYYY` and `DD-MM-YYYY`** — UK order, which is what a British
 *   letting agent's spreadsheet contains. The template says so, the upload
 *   screen says so, and the preview shows every parsed date back in long form
 *   so a misread is visible *before* anything is written.
 *
 * Everything else is refused by name:
 *
 * - **A two-digit year.** `01/02/26` could be 1926 or 2026. A rule that picks
 *   one is a rule that is wrong for somebody's records.
 * - **`MM/DD/YYYY`.** There is no way to tell it from the UK order except by
 *   guessing, and guessing is the failure this module exists to prevent. A
 *   value whose first component is above 12 is refused rather than silently
 *   re-read as American, because a file containing *those* is a file in the
 *   wrong order throughout and the agent needs to know.
 * - **Month names, dotted separators, `YYYY/MM/DD`** and anything else. Not
 *   because they cannot be parsed, but because each is another rule to explain
 *   and another way to be subtly wrong. The template is one click away.
 *
 * Pure. No clock, no locale, no `Date.parse` — which accepts almost anything
 * and resolves it against the host's timezone.
 */

export type DateProblem =
  | "not_a_date"
  | "two_digit_year"
  | "ambiguous_order"
  | "impossible_date"
  | "implausible_year";

export type ParsedDate =
  | { ok: true; iso: string }
  | { ok: false; problem: DateProblem };

/**
 * The window a real certificate or tenancy date falls in.
 *
 * Not a validation of business meaning — a certificate expiring in 2031 is
 * unusual but not this module's business — just a guard against a typo like
 * `2062` or a spreadsheet that turned a date into a serial number.
 */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const UK = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const SHORT_YEAR = /^(\d{1,2})[/-](\d{1,2})[/-](\d{1,2})$/;

/** Whether a year, month and day name a day that exists. Catches 31 February. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function iso(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

/**
 * Parses one cell.
 *
 * An empty cell is not this function's problem — the caller decides whether a
 * blank is allowed, because for a certificate expiry it very much is: "we do
 * not know" is a real and common answer, and inventing a date for it would put
 * a false renewal in front of a landlord.
 */
export function parseImportDate(value: string): ParsedDate {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, problem: "not_a_date" };

  const isoMatch = ISO.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (year < MIN_YEAR || year > MAX_YEAR) {
      return { ok: false, problem: "implausible_year" };
    }
    if (!isRealDate(year, month, day)) {
      return { ok: false, problem: "impossible_date" };
    }
    return { ok: true, iso: iso(year, month, day) };
  }

  const ukMatch = UK.exec(trimmed);
  if (ukMatch) {
    const first = Number(ukMatch[1]);
    const second = Number(ukMatch[2]);
    const year = Number(ukMatch[3]);

    if (year < MIN_YEAR || year > MAX_YEAR) {
      return { ok: false, problem: "implausible_year" };
    }

    /*
      In UK order the second component is the **month**, so a value above 12
      there cannot be one — the file is written month-first.

      Refused rather than quietly re-read the other way round. If this row is
      American, so are the rows where both parts are under 13, which is most of
      them — and those would be read a month wrong with nothing on screen to
      show it. One clear refusal that names the ordering beats a file that
      imports cleanly and is silently wrong.

      Both parts above 12 is not an ordering question at all; it falls through
      to the existence check below and is reported as an impossible date.
    */
    if (second > 12 && first <= 12) {
      return { ok: false, problem: "ambiguous_order" };
    }

    if (!isRealDate(year, second, first)) {
      return { ok: false, problem: "impossible_date" };
    }
    return { ok: true, iso: iso(year, second, first) };
  }

  if (SHORT_YEAR.test(trimmed)) {
    return { ok: false, problem: "two_digit_year" };
  }

  return { ok: false, problem: "not_a_date" };
}

/** What the agent is told, per problem. One sentence, and it says what to do. */
export function describeDateProblem(problem: DateProblem): string {
  switch (problem) {
    case "two_digit_year":
      return "Write the year in full — 01/02/2026, not 01/02/26.";
    case "ambiguous_order":
      return "This looks like month/day order. Use day/month — 03/04/2026 for 3 April 2026 — or YYYY-MM-DD.";
    case "impossible_date":
      return "That date does not exist.";
    case "implausible_year":
      return "Check the year.";
    case "not_a_date":
      return "Use YYYY-MM-DD or DD/MM/YYYY.";
  }
}

/** The accepted formats, for the guidance on screen and in the template. */
export const ACCEPTED_DATE_FORMATS = "YYYY-MM-DD or DD/MM/YYYY (day first)";

/**
 * A parsed date, written back out in long form.
 *
 * Shown in the preview beside every date, so a misread is caught by a person
 * before a single row is written — which is the real defence against an
 * ordering mistake, rather than any amount of cleverness in the parser.
 */
export function formatParsedDate(isoDate: string): string {
  const match = ISO.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
