import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clampPage,
  DEFAULT_FILTERS,
  ENGINEER_ANY,
  ENGINEER_NONE,
  isFiltered,
  jobFiltersToQuery,
  jobListHref,
  likePattern,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  pageCount,
  pageRange,
  parseJobFilters,
} from "./filters";

/**
 * A query string is untrusted input.
 *
 * These are the assertions that matter about this module: that nothing from a
 * URL reaches a query unvalidated, that a nonsense value narrows to a default
 * rather than failing a request, and — the important one — that there is no
 * field here through which a caller could widen what they are allowed to see.
 */

const UUID = "11111111-1111-4111-8111-111111111111";

describe("what a query string is allowed to say", () => {
  test("an empty query string is the unfiltered list", () => {
    assert.deepEqual(parseJobFilters({}), DEFAULT_FILTERS);
    assert.equal(isFiltered(parseJobFilters({})), false);
  });

  test("an unrecognised view, client or status falls back rather than throwing", () => {
    const filters = parseJobFilters({
      view: "everything",
      client: "vip",
      status: "on_fire",
    });
    assert.equal(filters.view, "all");
    assert.equal(filters.client, "all");
    assert.equal(filters.status, null);
  });

  test("a real status is kept", () => {
    assert.equal(parseJobFilters({ status: "in_progress" }).status, "in_progress");
  });

  test("the engineer filter accepts only an id, or 'nobody yet'", () => {
    assert.equal(parseJobFilters({ engineer: UUID }).engineer, UUID);
    assert.equal(parseJobFilters({ engineer: ENGINEER_NONE }).engineer, ENGINEER_NONE);
    // Anything else is "anybody" — never a value that reaches a uuid column.
    assert.equal(parseJobFilters({ engineer: "bobby" }).engineer, ENGINEER_ANY);
    assert.equal(
      parseJobFilters({ engineer: "' OR 1=1 --" }).engineer,
      ENGINEER_ANY,
    );
  });

  test("there is no organisation field, so a URL cannot choose whose rows to read", () => {
    /*
      The one assertion in this file that is about security rather than
      tidiness. Access is decided by the session's scope; if a filter for
      "which organisation" were ever added here, an agency user could read
      another agency's jobs with a hand-edited link.
    */
    const filters = parseJobFilters({
      organisation: "22222222-2222-4222-8222-222222222222",
      organisationId: "22222222-2222-4222-8222-222222222222",
      scope: "all",
    });
    assert.deepEqual(filters, DEFAULT_FILTERS);
    assert.equal("organisationId" in filters, false);
  });

  test("the search text is trimmed, collapsed and capped", () => {
    assert.equal(parseJobFilters({ q: "  WV1   1AA " }).query, "WV1 1AA");
    assert.equal(parseJobFilters({ q: "x".repeat(500) }).query.length, 80);
  });

  test("a repeated parameter takes the first value", () => {
    assert.equal(parseJobFilters({ q: ["one", "two"] }).query, "one");
  });

  test("the page number cannot be zero, negative or a word", () => {
    assert.equal(parseJobFilters({ page: "0" }).page, 1);
    assert.equal(parseJobFilters({ page: "-4" }).page, 1);
    assert.equal(parseJobFilters({ page: "last" }).page, 1);
    assert.equal(parseJobFilters({ page: "3" }).page, 3);
  });

  test("the page size is capped, so a URL cannot ask for the whole table", () => {
    assert.equal(parseJobFilters({ size: "100000" }).pageSize, MAX_PAGE_SIZE);
    assert.equal(parseJobFilters({ size: "0" }).pageSize, PAGE_SIZE);
    assert.equal(parseJobFilters({ size: "10" }).pageSize, 10);
  });
});

describe("filters round-trip into a link", () => {
  test("nothing selected produces a clean URL", () => {
    assert.equal(jobFiltersToQuery(DEFAULT_FILTERS), "");
    assert.equal(jobListHref(DEFAULT_FILTERS), "/admin/jobs");
  });

  test("what is written back parses to what was asked for", () => {
    const filters = parseJobFilters({
      q: "Smith",
      view: "attention",
      client: "agency",
      status: "scheduled",
      engineer: UUID,
      page: "4",
    });
    const url = new URL(`http://x${jobListHref(filters, { page: filters.page })}`);
    const round = parseJobFilters(Object.fromEntries(url.searchParams));
    assert.deepEqual(round, filters);
  });

  test("changing a control goes back to page one", () => {
    const filters = { ...DEFAULT_FILTERS, page: 7 };
    // A filter change that kept page 7 would show an empty list and look broken.
    assert.equal(jobListHref(filters, { view: "today" }), "/admin/jobs?view=today");
  });

  test("paging keeps the page it was given", () => {
    const filters = { ...DEFAULT_FILTERS, view: "today" as const, page: 2 };
    assert.equal(
      jobListHref(filters, { page: 3 }),
      "/admin/jobs?view=today&page=3",
    );
  });
});

describe("counting pages", () => {
  test("an empty list is page one of one, not page one of zero", () => {
    assert.equal(pageCount(0, 25), 1);
    assert.deepEqual(pageRange(1, 25, 0), { from: 0, to: 0 });
  });

  test("a partial last page is still a page", () => {
    assert.equal(pageCount(26, 25), 2);
    assert.deepEqual(pageRange(2, 25, 26), { from: 26, to: 26 });
  });

  test("asking beyond the end lands on the last page rather than on nothing", () => {
    // The row count can change between a link being made and being opened.
    assert.equal(clampPage(9, 60, 25), 3);
    assert.equal(clampPage(1, 0, 25), 1);
  });
});

describe("the search pattern", () => {
  test("a wildcard typed by a person is not a wildcard", () => {
    // Otherwise a customer called "%" matches every row in the table.
    assert.equal(likePattern("%"), "%\\%%");
    assert.equal(likePattern("_"), "%\\_%");
    assert.equal(likePattern("a\\b"), "%a\\\\b%");
  });

  test("ordinary text is wrapped and otherwise untouched", () => {
    assert.equal(likePattern("WV1 1AA"), "%WV1 1AA%");
  });
});
