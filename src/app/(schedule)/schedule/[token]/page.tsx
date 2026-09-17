import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { accessByToken } from "@/lib/scheduling/access";
import {
  SCHEDULING_COOKIE,
  issueSchedulingSession,
  schedulingCookieOptions,
} from "@/lib/scheduling/session";

export const dynamic = "force-dynamic";

/**
 * The invitation link.
 *
 * Spends the token at the door and replaces it with a signed, path-scoped
 * session naming that one job, then redirects. Two things follow from that:
 * the token stops travelling in the address bar after the first hop, and every
 * later request is authorised by something the tenant cannot forge or edit.
 *
 * A token that is unknown, expired, revoked or attached to a job that is no
 * longer schedulable all end in exactly the same place — the manual entry
 * page — because telling them apart would be an oracle.
 */
export default async function TokenEntryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const job = await accessByToken(token);

  if (!job) redirect("/schedule?problem=1");

  const session = issueSchedulingSession(job.jobId);
  const store = await cookies();
  store.set(
    SCHEDULING_COOKIE,
    session.value,
    schedulingCookieOptions(session.expiresAt),
  );

  redirect("/schedule/appointment");
}
