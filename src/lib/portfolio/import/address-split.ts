/**
 * Splitting one address cell into the parts the property record needs.
 *
 * Agency exports rarely carry `house`, `street`, `town` and `postcode` in four
 * columns. They carry one: `Flat 2, 14 Example Street, Wolverhampton, WV1 1AA`.
 * Retyping that for a hundred properties is the manual effort this removes.
 *
 * **It refuses far more readily than it guesses.** A wrong split is not a
 * cosmetic problem: `house_or_name` plus `postcode` is the key the duplicate
 * check compares on and the unique index enforces, so a flat number lost in
 * the street line silently merges two flats into one property, and a flat
 * number invented out of a house number splits one property into two. Anything
 * this module is not sure about comes back `ok: false` with a reason, and the
 * preview makes a person look at it.
 *
 * Pure. No database, no network, no locale.
 */

import { looksLikePostcode, normalisePostcode } from "@/lib/address/format";

export type AddressProblem =
  | "empty"
  | "no_postcode"
  | "postcode_unrecognised"
  | "too_few_parts"
  | "ambiguous_unit";

export type SplitAddress = {
  /** Unit and/or number — the part that distinguishes one flat from another. */
  houseOrName: string;
  street: string;
  town: string | null;
  postcode: string;
};

export type SplitResult =
  | { ok: true; value: SplitAddress }
  | { ok: false; problem: AddressProblem };

/**
 * Words that introduce a sub-property.
 *
 * Deliberately a short, explicit list. A fuzzy rule here would be the worst
 * kind of clever: it decides whether two records are the same property.
 */
const UNIT_WORDS =
  /^(flat|apartment|apt|unit|room|studio|suite|annexe|annex|basement|ground floor|first floor|second floor|third floor)\b/i;

/** A leading token that is a number, possibly with a letter: 14, 14a, 221b. */
const NUMBERISH = /^\d+[a-z]?$/i;

/** A part that begins with a number, e.g. "14 Example Street". */
const STARTS_WITH_NUMBER = /^(\d+[a-z]?)\s+(.*)$/i;

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Splits a combined address.
 *
 * Works from the **end**, because the end is the reliable part: a postcode is
 * recognisable by shape, and what precedes it is the town. The front is where
 * the ambiguity lives, so it is decided last and refused when unclear.
 *
 * Accepts commas or newlines as separators — exports use both, and a cell that
 * came from a textarea often carries the latter.
 */
export function splitAddress(value: string): SplitResult {
  /*
    Split **before** collapsing whitespace. `tidy` turns a newline into a
    space, so tidying first would erase the very separator a textarea export
    uses — "14 Example Street\nWolverhampton\nWV1 1AA" became one run-on line
    and the town was swallowed into the street.
  */
  const raw = (value ?? "").trim();
  if (!raw) return { ok: false, problem: "empty" };

  const parts = raw
    .split(/[,\n]+/)
    .map(tidy)
    .filter(Boolean);

  if (parts.length === 0) return { ok: false, problem: "empty" };

  /*
    The postcode, taken from the tail.

    Some exports put it on its own; some append it to the town —
    "Wolverhampton WV1 1AA". Both are handled by testing the last part whole,
    then testing its trailing words.
  */
  const last = parts[parts.length - 1];
  let postcode = "";
  let townFromLast: string | null = null;

  if (looksLikePostcode(last)) {
    postcode = normalisePostcode(last);
    parts.pop();
  } else {
    // "Wolverhampton WV1 1AA" — try the final two words, then the final one.
    const words = last.split(" ");
    for (const take of [2, 1]) {
      if (words.length <= take) continue;
      const candidate = words.slice(-take).join(" ");
      if (looksLikePostcode(candidate)) {
        postcode = normalisePostcode(candidate);
        townFromLast = tidy(words.slice(0, -take).join(" "));
        parts.pop();
        break;
      }
    }
  }

  if (!postcode) {
    /*
      Distinguish "there is no postcode here" from "there is something that
      looks like one and is not valid", because they are different mistakes
      with different fixes.
    */
    const looksLikeAnAttempt = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}\b/i.test(last);
    return {
      ok: false,
      problem: looksLikeAnAttempt ? "postcode_unrecognised" : "no_postcode",
    };
  }

  if (townFromLast) parts.push(townFromLast);

  if (parts.length === 0) return { ok: false, problem: "too_few_parts" };

  /*
    **The front is decided first, then whatever is left is the town.**

    The other way round does not work: popping the town before looking at the
    front mis-reads "14 Example Street, Wolverhampton", where the *first* part
    already contains both the number and the street and the second is the town.
    Deciding the house and street first leaves an unambiguous remainder.
  */
  const first = parts[0];
  const rest = parts.slice(1);

  /** Whatever is left after the house and street: the town, or nothing. */
  const townFrom = (remaining: string[]): string | null =>
    remaining.length > 0 ? remaining[remaining.length - 1] : null;

  /*
    A unit word — the case this module exists for. "Flat 2" alone is not unique
    within a postcode and "14" alone is the whole building, so both identifiers
    have to travel together or two flats become one property.
  */
  if (UNIT_WORDS.test(first)) {
    if (rest.length === 0) return { ok: false, problem: "ambiguous_unit" };

    const numbered = STARTS_WITH_NUMBER.exec(rest[0]);
    if (numbered) {
      return {
        ok: true,
        value: {
          houseOrName: `${first}, ${numbered[1]}`,
          street: tidy(numbered[2]),
          town: townFrom(rest.slice(1)),
          postcode,
        },
      };
    }

    if (NUMBERISH.test(rest[0]) && rest.length >= 2) {
      // "Flat 2", "14", "Example Street" — three separate parts.
      return {
        ok: true,
        value: {
          houseOrName: `${first}, ${rest[0]}`,
          street: rest[1],
          town: townFrom(rest.slice(2)),
          postcode,
        },
      };
    }

    /*
      A unit with nothing numeric after it. It may be complete, or the building
      number may have been dropped upstream — and a wrong guess merges or
      splits real properties, so it goes to a person.
    */
    return { ok: false, problem: "ambiguous_unit" };
  }

  // "14" as its own part, with the street next.
  if (NUMBERISH.test(first)) {
    if (rest.length === 0) return { ok: false, problem: "too_few_parts" };
    return {
      ok: true,
      value: {
        houseOrName: first,
        street: rest[0],
        town: townFrom(rest.slice(1)),
        postcode,
      },
    };
  }

  // "14 Example Street" as one part: split the leading number off.
  const numbered = STARTS_WITH_NUMBER.exec(first);
  if (numbered) {
    return {
      ok: true,
      value: {
        houseOrName: numbered[1],
        street: tidy(numbered[2]),
        town: townFrom(rest),
        postcode,
      },
    };
  }

  /*
    A named property: "Rose Cottage, Example Lane". The name identifies it and
    needs no number. With nothing after it there is no street, which is not
    enough to record a property.
  */
  if (rest.length === 0) return { ok: false, problem: "too_few_parts" };

  return {
    ok: true,
    value: {
      houseOrName: first,
      street: rest[0],
      town: townFrom(rest.slice(1)),
      postcode,
    },
  };
}

/** What the agent is told. One sentence, and it says what to do. */
export function describeAddressProblem(problem: AddressProblem): string {
  switch (problem) {
    case "empty":
      return "This address is blank.";
    case "no_postcode":
      return "No postcode found at the end of the address.";
    case "postcode_unrecognised":
      return "The postcode at the end is not one we recognise. Check it.";
    case "too_few_parts":
      return "This address has no house number or property name we can separate out.";
    case "ambiguous_unit":
      return "This names a flat or unit but no building number, so we cannot tell which property it is. Split it into the separate address columns, or add the number.";
  }
}
