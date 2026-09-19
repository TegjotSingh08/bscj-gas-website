/**
 * A CSV reader for a file somebody else made.
 *
 * Deliberately hand-written and deliberately small. A dependency would bring a
 * parser tuned for throughput over a stream; what is needed here is one that
 * treats every byte as hostile, stops early rather than late, and can be read
 * in one sitting by whoever has to answer "why was that row rejected".
 *
 * RFC 4180 as far as it goes, plus the three things real exports do:
 *
 * - **A BOM.** Excel writes one. Left in place it becomes part of the first
 *   header, which then matches nothing, and the whole file is rejected for a
 *   character nobody can see.
 * - **Any line ending.** CRLF, LF and a lone CR all end a row.
 * - **Quotes containing anything**, including commas and newlines, with `""`
 *   for a literal quote.
 *
 * Every limit below is a refusal rather than a truncation. Silently reading the
 * first 500 rows of a 900-row file is the worst possible outcome: the agent
 * sees a successful import and four hundred properties are simply absent.
 */

export const LIMITS = {
  /** 2 MB. A 500-row portfolio export is comfortably under 200 KB. */
  bytes: 2 * 1024 * 1024,
  /** Data rows, excluding the header. */
  rows: 500,
  /** Columns. Above this, something other than a portfolio was uploaded. */
  columns: 60,
  /** Characters in one cell. An access note is a sentence, not a document. */
  cell: 2000,
} as const;

export type CsvProblem =
  | { kind: "empty" }
  | { kind: "too_large"; bytes: number }
  | { kind: "too_many_rows"; rows: number }
  | { kind: "too_many_columns"; columns: number }
  | { kind: "cell_too_long"; row: number; column: number }
  | { kind: "unterminated_quote"; row: number }
  | { kind: "not_text" };

export type CsvTable = {
  header: string[];
  /** One entry per data row, already trimmed to the header's width. */
  rows: string[][];
  /**
   * The file's own line number for each data row, so an error can say "row 12"
   * and mean what the agent sees in their spreadsheet.
   */
  lineNumbers: number[];
};

export type CsvResult =
  | { ok: true; table: CsvTable }
  | { ok: false; problem: CsvProblem };

/**
 * Whether the bytes are plausibly text before anything tries to decode them.
 *
 * A NUL byte in the first few kilobytes means a binary file — most often an
 * .xlsx, which is a zip and starts `PK`. Refusing here gives a clear answer
 * instead of a parser producing thousands of nonsense rows from compressed
 * data.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Strips a UTF-8 BOM, which Excel writes and nothing else wants. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parses a whole file.
 *
 * Takes bytes rather than a string so the size limit is applied to what was
 * actually uploaded, and so a binary file is recognised before it is decoded
 * into millions of replacement characters.
 */
export function parseCsv(bytes: Uint8Array): CsvResult {
  if (bytes.length === 0) return { ok: false, problem: { kind: "empty" } };
  if (bytes.length > LIMITS.bytes) {
    return { ok: false, problem: { kind: "too_large", bytes: bytes.length } };
  }
  if (looksBinary(bytes)) return { ok: false, problem: { kind: "not_text" } };

  let text: string;
  try {
    // `fatal` so invalid UTF-8 is an error rather than a field full of U+FFFD
    // that then fails validation for a reason nobody can explain.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, problem: { kind: "not_text" } };
  }

  return parseCsvText(stripBom(text));
}

/**
 * The state machine.
 *
 * Exported for the tests, which is the only reason it is separate: every
 * awkward case — a quoted newline, a doubled quote, a trailing blank line — is
 * easier to state as text than as bytes.
 */
export function parseCsvText(text: string): CsvResult {
  const rows: string[][] = [];
  const lineNumbers: number[] = [];

  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowStartedAt = 1;
  let sawAnyCharacterThisRow = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };

  const endRow = (): CsvProblem | null => {
    endCell();
    /*
      A row that is entirely empty is skipped rather than rejected. Every
      spreadsheet writes a trailing newline, and a file with a blank line in
      the middle is a person's formatting, not a fault.
    */
    const blank = row.every((value) => value.trim() === "");
    if (!blank) {
      if (row.length > LIMITS.columns) {
        return { kind: "too_many_columns", columns: row.length };
      }
      for (let i = 0; i < row.length; i += 1) {
        if (row[i].length > LIMITS.cell) {
          return { kind: "cell_too_long", row: rowStartedAt, column: i + 1 };
        }
      }
      rows.push(row);
      lineNumbers.push(rowStartedAt);
      /*
        Bounded as it goes, not after the fact. A 50 MB file passes the byte
        check only if it is under 2 MB, but a 2 MB file of single-character
        rows is still a million rows, and building them all before counting is
        how a parser becomes the denial-of-service surface.
      */
      if (rows.length > LIMITS.rows + 1) {
        return { kind: "too_many_rows", rows: rows.length - 1 };
      }
    }
    row = [];
    sawAnyCharacterThisRow = false;
    return null;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!sawAnyCharacterThisRow && char !== "\n" && char !== "\r") {
      rowStartedAt = line;
      sawAnyCharacterThisRow = true;
    }

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      /*
        A quote only opens a field at its start. Mid-field it is a literal
        character — `12" pipe` is a real thing to write in an access note, and
        treating it as an opening quote would swallow the rest of the file.
      */
      if (cell === "") quoted = true;
      else cell += char;
      continue;
    }

    if (char === ",") {
      endCell();
      continue;
    }

    if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      const problem = endRow();
      if (problem) return { ok: false, problem };
      line += 1;
      continue;
    }

    if (char === "\n") {
      const problem = endRow();
      if (problem) return { ok: false, problem };
      line += 1;
      continue;
    }

    cell += char;
  }

  if (quoted) {
    return { ok: false, problem: { kind: "unterminated_quote", row: rowStartedAt } };
  }

  // The last row, when the file does not end with a newline.
  if (cell !== "" || row.length > 0) {
    const problem = endRow();
    if (problem) return { ok: false, problem };
  }

  if (rows.length === 0) return { ok: false, problem: { kind: "empty" } };

  const [header, ...dataRows] = rows;
  const dataLineNumbers = lineNumbers.slice(1);

  if (dataRows.length > LIMITS.rows) {
    return { ok: false, problem: { kind: "too_many_rows", rows: dataRows.length } };
  }
  if (header.length > LIMITS.columns) {
    return { ok: false, problem: { kind: "too_many_columns", columns: header.length } };
  }

  return {
    ok: true,
    table: {
      header,
      /*
        Padded to the header's width. A short row is the ordinary result of a
        spreadsheet omitting trailing empty cells, and it must read as blanks
        rather than as undefined somewhere further down.
      */
      rows: dataRows.map((values) =>
        header.map((_, index) => values[index] ?? ""),
      ),
      lineNumbers: dataLineNumbers,
    },
  };
}

/** What to tell the agent about a file that could not be read at all. */
export function describeCsvProblem(problem: CsvProblem): string {
  switch (problem.kind) {
    case "empty":
      return "That file has no rows in it.";
    case "too_large":
      return `That file is ${Math.round(problem.bytes / 1024)} KB. The limit is ${
        LIMITS.bytes / 1024 / 1024
      } MB — split it and import in parts.`;
    case "too_many_rows":
      return `That file has ${problem.rows} rows. The limit is ${LIMITS.rows} at a time — split it and import in parts.`;
    case "too_many_columns":
      return "That file has far more columns than a portfolio needs. Check you uploaded the right file.";
    case "cell_too_long":
      return `Row ${problem.row}, column ${problem.column} is far too long for the field it belongs in.`;
    case "unterminated_quote":
      return `There is an unclosed quotation mark at or after row ${problem.row}, so the rest of the file cannot be read.`;
    case "not_text":
      return "That does not look like a CSV file. If it is a spreadsheet, use File → Save As and choose CSV.";
  }
}
