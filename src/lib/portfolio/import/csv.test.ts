import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  describeCsvProblem,
  LIMITS,
  parseCsv,
  parseCsvText,
} from "./csv";
import { columnFor, HEADERS, templateCsv, normaliseHeader } from "./columns";

/**
 * Reading a file somebody else made.
 *
 * The cases below are the ones real exports actually produce, plus the ones
 * somebody hostile would produce. Both matter: the first decides whether the
 * feature works, the second decides whether it is safe.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the shapes a spreadsheet actually writes", () => {
  test("a plain file", () => {
    const result = parseCsvText("a,b\n1,2\n3,4\n");
    assert.ok(result.ok);
    assert.deepEqual(result.table.header, ["a", "b"]);
    assert.deepEqual(result.table.rows, [
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("CRLF, LF and a lone CR all end a row", () => {
    for (const ending of ["\r\n", "\n", "\r"]) {
      const result = parseCsvText(`a,b${ending}1,2${ending}`);
      assert.ok(result.ok, ending);
      assert.deepEqual(result.table.rows, [["1", "2"]]);
    }
  });

  test("a file with no trailing newline keeps its last row", () => {
    const result = parseCsvText("a,b\n1,2");
    assert.ok(result.ok);
    assert.deepEqual(result.table.rows, [["1", "2"]]);
  });

  test("Excel's byte order mark does not become part of the first header", () => {
    // Left in place it matches no column, and the whole file is rejected for a
    // character nobody can see.
    const result = parseCsv(bytes("﻿postcode,street\nWV1 1AA,Example"));
    assert.ok(result.ok);
    assert.equal(result.table.header[0], "postcode");
    assert.ok(columnFor(result.table.header[0]));
  });

  test("blank lines in the middle are skipped, not rejected", () => {
    const result = parseCsvText("a,b\n1,2\n\n3,4\n");
    assert.ok(result.ok);
    assert.equal(result.table.rows.length, 2);
  });

  test("a short row is padded to the header's width", () => {
    // Spreadsheets omit trailing empty cells. They must read as blanks, not as
    // undefined somewhere further down.
    const result = parseCsvText("a,b,c\n1\n");
    assert.ok(result.ok);
    assert.deepEqual(result.table.rows, [["1", "", ""]]);
  });

  test("line numbers are the ones the agent sees in their spreadsheet", () => {
    const result = parseCsvText("a,b\n1,2\n\n3,4\n");
    assert.ok(result.ok);
    // Header is line 1; the blank line 3 is skipped but still counted.
    assert.deepEqual(result.table.lineNumbers, [2, 4]);
  });
});

describe("quoting", () => {
  test("a quoted cell may contain a comma", () => {
    const result = parseCsvText('a,b\n"Flat 1, The Mews",Example Street\n');
    assert.ok(result.ok);
    assert.deepEqual(result.table.rows, [["Flat 1, The Mews", "Example Street"]]);
  });

  test("a quoted cell may contain a newline", () => {
    const result = parseCsvText('a,b\n"Key safe\nround the back",x\n');
    assert.ok(result.ok);
    assert.equal(result.table.rows[0][0], "Key safe\nround the back");
    assert.equal(result.table.rows.length, 1);
  });

  test('a doubled quote is one literal quote', () => {
    const result = parseCsvText('a\n"He said ""hello"""\n');
    assert.ok(result.ok);
    assert.equal(result.table.rows[0][0], 'He said "hello"');
  });

  test("a quote mid-cell is a literal character, not an opening quote", () => {
    // `12" pipe` is a real thing to write in an access note. Treating it as an
    // opening quote would swallow the rest of the file.
    const result = parseCsvText('a,b\n12" pipe,x\n');
    assert.ok(result.ok);
    assert.deepEqual(result.table.rows, [['12" pipe', "x"]]);
  });

  test("an unterminated quote is reported, not silently swallowed", () => {
    const result = parseCsvText('a,b\n"never closed,x\n');
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "unterminated_quote");
  });

  test("a quoted newline does not desynchronise the line numbers", () => {
    const result = parseCsvText('a,b\n"one\ntwo",x\n5,6\n');
    assert.ok(result.ok);
    // The second data row starts on the file's fourth line.
    assert.deepEqual(result.table.lineNumbers, [2, 4]);
  });
});

describe("limits refuse rather than truncate", () => {
  test("an empty file", () => {
    assert.equal(parseCsv(bytes("")).ok, false);
    assert.equal(parseCsvText("\n\n\n").ok, false);
  });

  test("a file over the byte limit", () => {
    const result = parseCsv(new Uint8Array(LIMITS.bytes + 1));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "too_large");
  });

  test("too many rows is refused, and the first 500 are NOT imported", () => {
    /*
      The single most important assertion in this file. Silently reading the
      first 500 rows of a 900-row file looks like success and leaves four
      hundred properties absent with nothing to show for it.
    */
    const rows = ["a,b", ...Array.from({ length: LIMITS.rows + 1 }, (_, i) => `${i},x`)];
    const result = parseCsvText(rows.join("\n"));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "too_many_rows");
  });

  test("exactly the row limit is accepted", () => {
    const rows = ["a,b", ...Array.from({ length: LIMITS.rows }, (_, i) => `${i},x`)];
    const result = parseCsvText(rows.join("\n"));
    assert.ok(result.ok);
    assert.equal(result.table.rows.length, LIMITS.rows);
  });

  test("an absurdly long cell is refused with its row and column", () => {
    const result = parseCsvText(`a,b\nx,${"y".repeat(LIMITS.cell + 1)}\n`);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "cell_too_long");
    if (!result.ok && result.problem.kind === "cell_too_long") {
      assert.equal(result.problem.row, 2);
      assert.equal(result.problem.column, 2);
    }
  });

  test("far too many columns is refused", () => {
    const wide = Array.from({ length: LIMITS.columns + 1 }, (_, i) => `c${i}`);
    const result = parseCsvText(`${wide.join(",")}\n`);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "too_many_columns");
  });
});

describe("uploaded content is treated as hostile", () => {
  test("a binary file is recognised before it is decoded", () => {
    // An .xlsx is a zip and begins "PK". Decoding it would produce thousands
    // of nonsense rows instead of one clear answer.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
    const result = parseCsv(zip);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.kind === "not_text");
  });

  test("invalid UTF-8 is an error, not a field full of replacement characters", () => {
    const broken = new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x0a]);
    const result = parseCsv(broken);
    assert.equal(result.ok, false);
  });

  test("a formula is read as text, never evaluated", () => {
    // Nothing here executes anything — the point is that it survives as the
    // literal string, so the validators below refuse it as a bad postcode
    // rather than it disappearing or changing shape.
    const result = parseCsvText('a\n=SUM(1+1)\n');
    assert.ok(result.ok);
    assert.equal(result.table.rows[0][0], "=SUM(1+1)");
  });

  test("markup in a cell stays a string", () => {
    const result = parseCsvText('a\n<script>alert(1)</script>\n');
    assert.ok(result.ok);
    assert.equal(result.table.rows[0][0], "<script>alert(1)</script>");
  });

  test("every problem has a sentence a person can act on", () => {
    const problems = [
      { kind: "empty" as const },
      { kind: "too_large" as const, bytes: 9_000_000 },
      { kind: "too_many_rows" as const, rows: 900 },
      { kind: "too_many_columns" as const, columns: 99 },
      { kind: "cell_too_long" as const, row: 4, column: 2 },
      { kind: "unterminated_quote" as const, row: 7 },
      { kind: "not_text" as const },
    ];
    for (const problem of problems) {
      const message = describeCsvProblem(problem);
      assert.ok(message.length > 10, problem.kind);
      assert.match(message, /[.!]$/, problem.kind);
    }
  });
});

describe("the template and the parser cannot drift apart", () => {
  test("every template header matches a column", () => {
    for (const header of HEADERS) {
      assert.ok(columnFor(header), header);
    }
  });

  test("the template parses as its own input", () => {
    const parsed = parseCsv(bytes(templateCsv()));
    assert.ok(parsed.ok);
    assert.equal(parsed.table.header.length, HEADERS.length);
    assert.equal(parsed.table.rows.length, 1);
    for (const header of parsed.table.header) {
      assert.ok(columnFor(header), header);
    }
  });

  test("the example row uses a reserved domain, so it cannot be a real person", () => {
    // An agent who forgets to delete it gets a fictional landlord, not a
    // property attributed to somebody who exists.
    assert.match(templateCsv(), /example\.invalid/);
  });

  test("headers are matched forgivingly about case, spaces and underscores", () => {
    assert.equal(normaliseHeader("  Post Code "), "post_code");
    assert.equal(columnFor("POSTCODE")?.key, "postcode");
    assert.equal(columnFor("Post Code")?.key, "postcode");
    assert.equal(columnFor("post-code")?.key, "postcode");
  });

  test("a header nobody can match returns null rather than guessing", () => {
    // A guess that is right nine times in ten puts a landlord's phone number
    // in the tenant's column the tenth time, and nothing downstream notices.
    assert.equal(columnFor("some_other_thing"), null);
    assert.equal(columnFor(""), null);
  });
});
