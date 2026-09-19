import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  endOfDayInZone,
  isDeadlinePast,
  meetsDeadline,
  resolveDeadline,
  toNotice,
} from "./deadline";

/**
 * By when the work has to be done.
 *
 * Two dates can say so and they mean different things — the date the agent
 * asked for, and the date the existing certificate stops covering the
 * property. The rules are: take the **earlier**, keep **both**, and treat "no
 * date at all" as no deadline rather than as a deadline of "whenever".
 *
 * The boundary tests are the point of this file. "Finish by the end of that
 * date" is a wall-clock statement in a timezone that changes offset twice a
 * year, so it cannot be done with arithmetic on instants.
 */

const TZ = "Europe/London";

describe("which date is the cutoff", () => {
  test("the earlier of the two wins", () => {
    const deadline = resolveDeadline(
      { requestedBy: "2026-10-10", certificateDueBy: "2026-11-30" },
      TZ,
    );
    assert.equal(deadline.status, "set");
    assert.equal((deadline as { date: string }).date, "2026-10-10");
    assert.equal((deadline as { source: string }).source, "requested");
  });

  test("the certificate wins when it is the earlier one", () => {
    const deadline = resolveDeadline(
      { requestedBy: "2026-11-30", certificateDueBy: "2026-10-10" },
      TZ,
    );
    assert.equal((deadline as { date: string }).date, "2026-10-10");
    assert.equal((deadline as { source: string }).source, "certificate");
  });

  test("both are preserved whichever one wins", () => {
    /*
      They are never collapsed. An invoice, an email and an admin screen all
      have to be able to say what was asked for *and* when cover runs out.
    */
    const deadline = resolveDeadline(
      { requestedBy: "2026-11-30", certificateDueBy: "2026-10-10" },
      TZ,
    ) as { requestedBy: string; certificateDueBy: string };

    assert.equal(deadline.requestedBy, "2026-11-30");
    assert.equal(deadline.certificateDueBy, "2026-10-10");
  });

  test("the same day is reported as both, not as one of them", () => {
    const deadline = resolveDeadline(
      { requestedBy: "2026-10-10", certificateDueBy: "2026-10-10" },
      TZ,
    );
    assert.equal((deadline as { source: string }).source, "both");
  });

  test("one date alone is the cutoff", () => {
    const requested = resolveDeadline(
      { requestedBy: "2026-10-10", certificateDueBy: null },
      TZ,
    );
    assert.equal((requested as { source: string }).source, "requested");

    const certificate = resolveDeadline(
      { requestedBy: null, certificateDueBy: "2026-10-10" },
      TZ,
    );
    assert.equal((certificate as { source: string }).source, "certificate");
  });

  test("neither date means no deadline, not a lenient one", () => {
    const deadline = resolveDeadline(
      { requestedBy: null, certificateDueBy: null },
      TZ,
    );
    assert.equal(deadline.status, "none");
    assert.equal(toNotice(deadline), null);
  });

  test("a malformed date is absent, not a cutoff nobody can compute", () => {
    // It must not become a deadline that refuses everything, and it must not
    // become one that accepts everything either. Absent changes nothing.
    for (const bad of ["", "not-a-date", "2026-13-01", "2026-10-99"]) {
      const deadline = resolveDeadline(
        { requestedBy: bad, certificateDueBy: null },
        TZ,
      );
      assert.equal(deadline.status, "none", bad);
    }
  });

  test("a timestamp is read as the date it falls on", () => {
    const deadline = resolveDeadline(
      { requestedBy: "2026-10-10T00:00:00.000Z", certificateDueBy: null },
      TZ,
    );
    assert.equal((deadline as { date: string }).date, "2026-10-10");
  });
});

describe("the end of the day, in London", () => {
  test("it is midnight at the start of the next day", () => {
    // Exclusive: an appointment ending at exactly 00:00 finished on the day.
    assert.equal(
      endOfDayInZone("2026-01-15", TZ).toISOString(),
      "2026-01-16T00:00:00.000Z",
    );
  });

  test("British Summer Time is an hour ahead of UTC", () => {
    /*
      A July deadline ends at 23:00 UTC, not midnight. Treating the date as UTC
      would give an appointment a spare hour it does not have.
    */
    assert.equal(
      endOfDayInZone("2026-07-15", TZ).toISOString(),
      "2026-07-15T23:00:00.000Z",
    );
  });

  test("the day the clocks go forward still ends at London midnight", () => {
    // 29 March 2026: 01:00 becomes 02:00, so the day is 23 hours long.
    assert.equal(
      endOfDayInZone("2026-03-29", TZ).toISOString(),
      "2026-03-29T23:00:00.000Z",
    );
  });

  test("the day the clocks go back still ends at London midnight", () => {
    /*
      25 October 2026: the clocks go back at 02:00, so the day is **25 hours
      long** — it begins at 23:00 UTC on the 24th (BST) and ends at 00:00 UTC
      on the 26th (GMT). Adding 24 hours to its start would land an hour early
      and cut an hour off the deadline.
    */
    assert.equal(
      endOfDayInZone("2026-10-25", TZ).toISOString(),
      "2026-10-26T00:00:00.000Z",
    );

    // The hour that only exists because of the change is still inside the day.
    const deadline = resolveDeadline(
      { requestedBy: "2026-10-25", certificateDueBy: null },
      TZ,
    );
    assert.equal(
      meetsDeadline(new Date("2026-10-25T23:30:00.000Z"), deadline),
      true,
      "an appointment inside the extra hour was pushed outside the deadline",
    );
  });

  test("the day after the clocks go back ends at UTC midnight", () => {
    assert.equal(
      endOfDayInZone("2026-10-26", TZ).toISOString(),
      "2026-10-27T00:00:00.000Z",
    );
  });

  test("month and year ends roll over correctly", () => {
    assert.equal(
      endOfDayInZone("2026-12-31", TZ).toISOString(),
      "2027-01-01T00:00:00.000Z",
    );
    assert.equal(
      endOfDayInZone("2028-02-29", TZ).toISOString(),
      "2028-03-01T00:00:00.000Z",
    );
  });
});

describe("whether an appointment meets the cutoff", () => {
  const deadline = resolveDeadline(
    { requestedBy: "2026-07-15", certificateDueBy: null },
    TZ,
  );

  test("finishing during the day meets it", () => {
    assert.equal(
      meetsDeadline(new Date("2026-07-15T16:45:00.000Z"), deadline),
      true,
    );
  });

  test("finishing at the very end of the day meets it", () => {
    // 00:00 London the next day is the exclusive bound, and landing exactly on
    // it means the appointment finished on the deadline date.
    assert.equal(
      meetsDeadline(new Date("2026-07-15T23:00:00.000Z"), deadline),
      true,
    );
  });

  test("finishing a minute later does not", () => {
    assert.equal(
      meetsDeadline(new Date("2026-07-15T23:01:00.000Z"), deadline),
      false,
    );
  });

  test("it is the END that is compared, not the start", () => {
    /*
      The rule the whole feature turns on. A 60-minute booking starting at
      23:30 London starts on the deadline date and does not finish on it.
      Comparing starts would let it through.
    */
    const startsInTime = new Date("2026-07-15T22:30:00.000Z"); // 23:30 London
    const endsNextDay = new Date(startsInTime.getTime() + 60 * 60000);

    assert.equal(meetsDeadline(startsInTime, deadline), true);
    assert.equal(meetsDeadline(endsNextDay, deadline), false);
  });

  test("no deadline accepts everything", () => {
    const none = resolveDeadline(
      { requestedBy: null, certificateDueBy: null },
      TZ,
    );
    assert.equal(meetsDeadline(new Date("2099-01-01T00:00:00.000Z"), none), true);
  });
});

describe("a cutoff that has already gone", () => {
  const deadline = resolveDeadline(
    { requestedBy: "2026-07-15", certificateDueBy: null },
    TZ,
  );

  test("before the end of the day it has not passed", () => {
    assert.equal(
      isDeadlinePast(deadline, new Date("2026-07-15T22:59:00.000Z")),
      false,
    );
  });

  test("at the end of the day it has", () => {
    assert.equal(
      isDeadlinePast(deadline, new Date("2026-07-15T23:00:00.000Z")),
      true,
    );
  });

  test("no deadline is never past", () => {
    const none = resolveDeadline(
      { requestedBy: null, certificateDueBy: null },
      TZ,
    );
    assert.equal(isDeadlinePast(none, new Date("2099-01-01T00:00:00.000Z")), false);
  });
});

describe("what crosses to the browser", () => {
  test("the notice carries both dates and the exclusive bound", () => {
    const notice = toNotice(
      resolveDeadline(
        { requestedBy: "2026-10-10", certificateDueBy: "2026-11-30" },
        TZ,
      ),
    );

    assert.deepEqual(notice, {
      date: "2026-10-10",
      source: "requested",
      requestedBy: "2026-10-10",
      certificateDueBy: "2026-11-30",
      endsBeforeIso: "2026-10-10T23:00:00.000Z",
    });
  });
});
