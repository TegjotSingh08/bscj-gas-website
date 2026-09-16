import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { businessSettings } from "@/lib/db/schema";
import {
  BUSINESS_IDENTITY_KEY,
  INVOICE_TERMS_KEY,
  VAT_SETTING_KEY,
  EMPTY_BUSINESS_IDENTITY,
  EMPTY_INVOICE_TERMS,
  NOT_VAT_REGISTERED,
  parseBusinessIdentity,
  parseInvoiceTerms,
  parseVatPosition,
  type BusinessIdentity,
  type InvoiceTerms,
  type VatPosition,
} from "./business-identity";

/**
 * Reading and writing the settings rows.
 *
 * Kept apart from `business-identity.ts` so the shapes and the rules about
 * them stay testable without a database, and so the only code that touches
 * Postgres is this file.
 *
 * Every read degrades to the empty value when there is no database. A missing
 * `DATABASE_URL` must not crash a page — it must make the page say the
 * business identity is not configured, which is true and actionable.
 */

async function readSetting(key: string): Promise<unknown> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({ value: businessSettings.value })
    .from(businessSettings)
    .where(eq(businessSettings.key, key))
    .limit(1);

  return row?.value ?? null;
}

export async function getBusinessIdentity(): Promise<BusinessIdentity> {
  try {
    return parseBusinessIdentity(await readSetting(BUSINESS_IDENTITY_KEY));
  } catch {
    return EMPTY_BUSINESS_IDENTITY;
  }
}

export async function getVatPosition(): Promise<VatPosition> {
  try {
    return parseVatPosition(await readSetting(VAT_SETTING_KEY));
  } catch {
    // The safe direction: an unreadable VAT row must never charge tax.
    return NOT_VAT_REGISTERED;
  }
}

export async function getInvoiceTerms(): Promise<InvoiceTerms> {
  try {
    return parseInvoiceTerms(await readSetting(INVOICE_TERMS_KEY));
  } catch {
    return EMPTY_INVOICE_TERMS;
  }
}

/**
 * Writes a setting, recording who changed it.
 *
 * Upsert rather than insert-or-update by hand: two administrators saving at
 * once should produce one row and a last-write-wins, not a unique violation.
 */
export async function putSetting(
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set.");

  await db
    .insert(businessSettings)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({
      target: businessSettings.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
}
