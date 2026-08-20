import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildEventId,
  CalendarApiError,
  parseFreeBusyResponse,
  type FreeBusyResponse,
} from "./calendar";

const CALENDAR_ID = "engineer@bscj-solutions.com";

/**
 * These tests exist because the failure that matters most here is a silent
 * one: treating an unreadable calendar as an empty calendar would make the
 * site offer slots the engineer is not free for, and the pre-write re-check
 * in /api/book would agree with it.
 */
describe("free/busy parsing fails closed", () => {
  test("busy periods are returned when the calendar reads correctly", () => {
    const response: FreeBusyResponse = {
      calendars: {
        [CALENDAR_ID]: {
          busy: [
            { start: "2026-08-20T09:00:00Z", end: "2026-08-20T09:45:00Z" },
            { start: "2026-08-20T13:00:00Z", end: "2026-08-20T13:45:00Z" },
          ],
        },
      },
    };

    const busy = parseFreeBusyResponse(response, CALENDAR_ID);
    assert.equal(busy.length, 2);
    assert.equal(busy[0].start.toISOString(), "2026-08-20T09:00:00.000Z");
    assert.equal(busy[1].end.toISOString(), "2026-08-20T13:45:00.000Z");
  });

  test("a genuinely empty diary is still an empty diary", () => {
    const response: FreeBusyResponse = {
      calendars: { [CALENDAR_ID]: { busy: [] } },
    };
    assert.deepEqual(parseFreeBusyResponse(response, CALENDAR_ID), []);
  });

  test("an errors array throws instead of reporting a free day", () => {
    // Google answers HTTP 200 with this shape when access is revoked or the
    // calendar id is wrong.
    const response: FreeBusyResponse = {
      calendars: {
        [CALENDAR_ID]: {
          busy: [],
          errors: [{ domain: "global", reason: "notFound" }],
        },
      },
    };

    assert.throws(
      () => parseFreeBusyResponse(response, CALENDAR_ID),
      (error: unknown) =>
        error instanceof CalendarApiError && error.status === 403,
    );
  });

  test("the thrown message never echoes Google's reason or the calendar id", () => {
    const response: FreeBusyResponse = {
      calendars: {
        [CALENDAR_ID]: { busy: [], errors: [{ reason: "forbidden" }] },
      },
    };

    try {
      parseFreeBusyResponse(response, CALENDAR_ID);
      assert.fail("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(!message.includes("forbidden"));
      assert.ok(!message.includes(CALENDAR_ID));
    }
  });

  test("a missing calendars object throws", () => {
    assert.throws(
      () => parseFreeBusyResponse({}, CALENDAR_ID),
      CalendarApiError,
    );
  });

  test("a missing busy array throws rather than defaulting to free", () => {
    const response: FreeBusyResponse = { calendars: { [CALENDAR_ID]: {} } };
    assert.throws(
      () => parseFreeBusyResponse(response, CALENDAR_ID),
      CalendarApiError,
    );
  });

  test("an unparseable busy period throws rather than behaving as free time", () => {
    const response: FreeBusyResponse = {
      calendars: {
        [CALENDAR_ID]: {
          busy: [{ start: "not-a-date", end: "also-not-a-date" }],
        },
      },
    };
    assert.throws(
      () => parseFreeBusyResponse(response, CALENDAR_ID),
      CalendarApiError,
    );
  });

  test("a differently-cased key still resolves, since only one calendar is asked for", () => {
    const response: FreeBusyResponse = {
      calendars: {
        "Engineer@BSCJ-Solutions.com": {
          busy: [{ start: "2026-08-20T09:00:00Z", end: "2026-08-20T09:45:00Z" }],
        },
      },
    };

    const busy = parseFreeBusyResponse(response, CALENDAR_ID);
    assert.equal(busy.length, 1);
  });

  test("an unrecognised key among several throws rather than guessing", () => {
    const response: FreeBusyResponse = {
      calendars: {
        "someone@example.com": { busy: [] },
        "another@example.com": { busy: [] },
      },
    };
    assert.throws(
      () => parseFreeBusyResponse(response, CALENDAR_ID),
      CalendarApiError,
    );
  });
});

describe("deterministic event id", () => {
  const slot = "2026-08-20T13:00:00.000Z";

  test("the same slot and key always produce the same id", () => {
    assert.equal(buildEventId(slot, "key-one"), buildEventId(slot, "key-one"));
  });

  test("a different attempt key produces a different id", () => {
    assert.notEqual(buildEventId(slot, "key-one"), buildEventId(slot, "key-two"));
  });

  test("the same key on a different slot produces a different id", () => {
    assert.notEqual(
      buildEventId(slot, "key-one"),
      buildEventId("2026-08-20T14:00:00.000Z", "key-one"),
    );
  });

  test("the id satisfies Google's required character set and length", () => {
    const id = buildEventId(slot, "key-one");
    assert.match(id, /^[a-v0-9]+$/);
    assert.ok(id.length >= 5 && id.length <= 1024);
  });
});
