"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { accessByReference } from "@/lib/scheduling/access";
import {
  SCHEDULING_COOKIE,
  issueSchedulingSession,
  schedulingCookieOptions,
} from "@/lib/scheduling/session";

/**
 * Manual entry: a reference from a letter, plus the property's postcode.
 *
 * **One message for every failure.** Unknown reference, wrong postcode,
 * expired job, rate limited — the tenant sees the same words. A reference is
 * six readable characters precisely so it can be quoted on the phone, which is
 * why it is not a secret; a form that said "that reference exists but the
 * postcode is wrong" would turn it into one anyone could enumerate.
 *
 * The rate limits live in `accessByReference`, per caller *and* per reference,
 * so neither one machine sweeping many references nor many machines sweeping
 * one gets far.
 */

export type LookupState = { failed?: boolean };

/*
  The message itself lives in `LookupForm`, next to the markup that renders it.

  It used to be exported from here as well, and a `"use server"` module may
  export nothing but async functions — Next refuses the module at evaluation
  time, which meant **every** reference-and-postcode submission answered HTTP
  500 before the action ran at all. Nothing imported the constant; it simply
  broke the door it was meant to describe.
*/

export async function lookupJobAction(
  _previous: LookupState,
  form: FormData,
): Promise<LookupState> {
  const reference = String(form.get("reference") ?? "");
  const postcode = String(form.get("postcode") ?? "");

  const headerList = await headers();
  const clientKey =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const result = await accessByReference(reference, postcode, clientKey);

  // Rate limiting is deliberately indistinguishable from a wrong answer here.
  // Saying "too many attempts" confirms that attempts were worth making.
  if (result.status !== "ok") return { failed: true };

  const session = issueSchedulingSession(result.job.jobId);
  const store = await cookies();
  store.set(
    SCHEDULING_COOKIE,
    session.value,
    schedulingCookieOptions(session.expiresAt),
  );

  redirect("/schedule/appointment");
}
