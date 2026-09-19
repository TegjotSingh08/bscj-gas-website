"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit/record";
import {
  BUSINESS_IDENTITY_KEY,
  INVOICE_TERMS_KEY,
  parseBusinessIdentity,
  parseInvoiceTerms,
} from "@/lib/settings/business-identity";
import { putSetting } from "@/lib/settings/store";

/**
 * Saving the business details an invoice has to carry.
 *
 * Every field here is a fact about BSCJ that **a person supplies**. Nothing
 * in this application invents one, nothing falls back to a plausible default,
 * and an empty field stays empty and blocks issuing rather than being filled
 * in on somebody's behalf. A guessed company name or a guessed set of bank
 * details on a document is a claim this code is not entitled to make.
 *
 * **VAT is deliberately not editable here.** BSCJ is not registered
 * (confirmed 16 September 2026), the setting is modelled in full and switched
 * off, and turning it on is a decision with consequences for every document
 * issued afterwards — it belongs to a deliberate change with a rate and a
 * date, not to a checkbox on a form beside the telephone number.
 */

export type SettingsState = { message?: string; error?: string };

function text(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
}

function lines(form: FormData, key: string): string[] {
  return String(form.get(key) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export async function saveBusinessDetailsAction(
  _previous: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const session = await requireAdmin();

  const dueDaysRaw = String(form.get("paymentDueDays") ?? "").trim();
  const dueDays = dueDaysRaw === "" ? null : Number(dueDaysRaw);
  if (dueDays !== null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365)) {
    return { error: "Payment days has to be a whole number of days, or empty." };
  }

  /*
    Parsed through the same functions that read the stored value, so what is
    written is exactly what will be read back. A field that round-trips
    through a different shape than it was validated in is how a setting
    quietly stops meaning what somebody typed.
  */
  const identity = parseBusinessIdentity({
    displayName: text(form, "displayName"),
    tradingName: text(form, "tradingName"),
    legalName: text(form, "legalName"),
    companyNumber: text(form, "companyNumber"),
    addressLines: lines(form, "addressLines"),
    postcode: text(form, "postcode"),
    phone: text(form, "phone"),
    email: text(form, "email"),
    website: text(form, "website"),
    gasSafeNumber: text(form, "gasSafeNumber"),
    footerText: text(form, "footerText"),
    tagline: text(form, "tagline"),
    qualifications: text(form, "qualifications"),
    serviceLines: lines(form, "serviceLines"),
  });

  const terms = parseInvoiceTerms({
    paymentTerms: text(form, "paymentTerms"),
    paymentDueDays: dueDays,
    paymentInstructions: text(form, "paymentInstructions"),
  });

  try {
    await putSetting(BUSINESS_IDENTITY_KEY, identity, session.user.id);
    await putSetting(INVOICE_TERMS_KEY, terms, session.user.id);
  } catch {
    return { error: "Those details could not be saved." };
  }

  /*
    Audited, and **without the values**. The security log records that the
    identity every future invoice will carry was changed, and by whom. What it
    was changed to is on the settings row and on every invoice issued after
    it; duplicating bank details into an append-only log is not worth it.
  */
  await recordAudit({
    actorUserId: session.user.id,
    actorDescription: session.user.email,
    kind: "settings.business_identity_updated",
    subjectType: "business_setting",
    subjectId: BUSINESS_IDENTITY_KEY,
    detail: {
      hasLegalName: identity.legalName !== null,
      hasPaymentInstructions: terms.paymentInstructions !== null,
    },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/invoices");

  return {
    message:
      "Saved. Invoices issued from now on carry these details; ones already issued keep what was true on their date.",
  };
}
