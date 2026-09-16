import "server-only";

import { sql } from "drizzle-orm";

import { requireDb } from "@/lib/db/client";
import { formatInvoiceNumber } from "./number";

/**
 * Drawing the next invoice number.
 *
 * `nextval` is atomic and never hands the same value to two callers, so this
 * needs no lock, no retry and no transaction of its own. A number drawn by a
 * transaction that later rolls back is simply never used — the resulting gap
 * in the series is expected, and is a far smaller problem than two invoices
 * sharing a number.
 *
 * The sequence is created in `drizzle/0001_invoice_number_sequence.sql`.
 */

/** The sequence name, matching the migration. */
const SEQUENCE = "invoice_number_seq";

/**
 * Allocates the next number.
 *
 * Call this once, at the moment an invoice is *issued* — not when a draft is
 * created. A draft that is abandoned should not consume a number a business
 * then has to explain the absence of.
 */
export async function allocateInvoiceNumber(): Promise<string> {
  const db = requireDb();

  const result = await db.execute<{ value: string }>(
    sql`SELECT nextval(${SEQUENCE}) AS value`,
  );

  // Postgres returns bigint as a string through the driver; Number is safe
  // here because six digits is nowhere near the precision limit, and the guard
  // in formatInvoiceNumber catches anything that is not a whole number.
  return formatInvoiceNumber(Number(result.rows[0]?.value));
}
