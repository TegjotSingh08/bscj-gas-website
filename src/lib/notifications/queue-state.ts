/**
 * What an operator sees about one queued message, and what they can do.
 *
 * **The pilot problem this exists for.** An agency job queued a tenant
 * invitation and nothing happened. The dashboard was green, the job page said
 * "Queued", and the only way to find out why was a browser console. A queue
 * that can only be counted is a list of problems with no button.
 *
 * The stored `state` column is deliberately coarse — `pending`, `sent`,
 * `failed`, `cancelled` — because it is what the worker needs. An operator
 * needs more than that, and all of it is derivable from what is already
 * recorded: how many attempts there have been, whether a lease is currently
 * held, and what the last error said. So nothing new is stored.
 *
 * **Two distinctions the coarse states cannot make**, and both of them cost
 * somebody an afternoon in the pilot:
 *
 * 1. **Queued and never tried** is not the same as **tried and waiting to be
 *    tried again.** The first might mean the schedule is not running at all;
 *    the second means it is running and something is wrong with the message.
 * 2. **Failed** is not the same as **cannot be sent because we have no address
 *    for the recipient.** The first wants a retry; the second wants somebody to
 *    add an email address, and retrying it forever changes nothing.
 *
 * `sent` is reported as **accepted by the provider** everywhere, never as
 * delivered. Resend taking a message is not somebody reading it, and the
 * product must not claim a delivery receipt it has never had.
 *
 * Pure.
 */

/** The coarse state as the worker stores it. */
export type StoredState = "pending" | "sent" | "failed" | "cancelled";

export type QueueState =
  /** Queued and not yet attempted. */
  | "queued"
  /** A worker holds it right now. */
  | "attempting"
  /** Attempted and waiting for its next attempt. */
  | "retrying"
  /** Attempted, and it cannot go until somebody supplies an address. */
  | "needs_information"
  /** The provider accepted it. Not a delivery receipt. */
  | "accepted"
  /** Given up on after the bounded attempts. Needs a person. */
  | "failed"
  /** Stood down because what it described changed. Not a failure. */
  | "cancelled";

export type QueueRowInput = {
  state: StoredState;
  attempts: number;
  lastError: string | null;
  /** Moved to now whenever a worker claims the row; this is the lease. */
  updatedAt: Date;
};

/**
 * The suffix the worker writes when the recipient has no address on file.
 *
 * Matched rather than parsed: the kinds each write their own prefix
 * (`tenant_email_missing`, `agent_email_missing`, …), and what they share is
 * the reason.
 */
const MISSING_RECIPIENT = /_email_missing$/;

export function isMissingRecipient(lastError: string | null): boolean {
  return MISSING_RECIPIENT.test(lastError ?? "");
}

/**
 * Where a row actually stands, for a person.
 *
 * `leaseSeconds` and `now` are passed in rather than read, so this is testable
 * without a clock and stays the same rule the worker applies.
 */
export function queueStateOf(
  row: QueueRowInput,
  options: { leaseSeconds: number; now: Date },
): QueueState {
  if (row.state === "sent") return "accepted";
  if (row.state === "cancelled") return "cancelled";
  if (row.state === "failed") return "failed";

  /*
    Pending, and still waiting on something a retry cannot fix. Reported
    separately from "retrying" because the action is different: somebody has to
    add an email address, and until they do every attempt will land here again.
  */
  if (isMissingRecipient(row.lastError)) return "needs_information";

  if (row.attempts === 0) return "queued";

  /*
    The lease. A claim moves `updated_at` to now, so a row that moved within
    the window is being worked on rather than waiting — which is the difference
    between "nothing is happening" and "something is happening right now", and
    the pilot could not tell them apart.
  */
  const heldFor = options.now.getTime() - row.updatedAt.getTime();
  if (heldFor < options.leaseSeconds * 1000) return "attempting";

  return "retrying";
}

export const QUEUE_STATE_LABELS: Readonly<Record<QueueState, string>> = {
  queued: "Queued",
  attempting: "Being sent now",
  retrying: "Waiting to try again",
  needs_information: "Needs an email address",
  // Never "delivered", never "sent to their inbox".
  accepted: "Accepted by the email provider",
  failed: "Failed — needs a person",
  cancelled: "Stood down",
};

export const QUEUE_STATE_EXPLANATION: Readonly<Record<QueueState, string>> = {
  queued:
    "Recorded and waiting for the next scheduled run. If this has not moved within about fifteen minutes, check that the scheduled job is running.",
  attempting: "A worker is sending it at the moment. Leave it alone.",
  retrying:
    "An attempt did not succeed and another is due. The number of attempts is bounded — after that it stops and says so.",
  needs_information:
    "There is no email address on file for the recipient this was meant for. Add one on their record; retrying without it will land here again.",
  accepted:
    "The email provider accepted it. That is not a delivery receipt and does not mean anybody has read it — the provider's own dashboard is the next level of evidence.",
  failed:
    "Every attempt has been used. Nothing further happens on its own. Read the reason, fix what it names, then send it again.",
  cancelled:
    "What this message described changed before it went — usually an appointment that moved. Nothing was sent, and that was the right outcome.",
};

/**
 * Whether an operator may put this row back in the queue.
 *
 * Only a terminal failure. A `pending` row is going to be tried again on its
 * own and touching it would either do nothing or reset a lease somebody is
 * holding; an accepted one cannot be recalled and must never be made to look
 * unsent; a cancelled one was stood down deliberately.
 *
 * A `needs_information` row is **not** retryable from here even though it is
 * technically failed-looking: there is nothing to retry until an address
 * exists, and offering the button would be offering a control that cannot
 * work.
 */
export function canRetry(state: QueueState): boolean {
  return state === "failed";
}

/**
 * The last error, in words an operator can act on.
 *
 * Provider messages can carry an address or a payload fragment, so nothing raw
 * reaches the screen. Recognised reasons get a sentence; anything else is
 * reported as unrecognised, with its short code kept so it can be searched for
 * in the logs, rather than rendered verbatim.
 */
export function describeError(lastError: string | null): string | null {
  if (!lastError) return null;

  const code = lastError.trim().slice(0, 60);

  if (isMissingRecipient(code)) {
    const who = code.replace(MISSING_RECIPIENT, "").replace(/_/g, " ").trim();
    return `No email address on file for the ${who || "recipient"}.`;
  }

  /*
    The vocabulary the worker actually writes. Anything not listed is reported
    by its code rather than guessed at — inventing a friendly sentence for a
    reason nobody has seen is how an operator is sent in the wrong direction.
  */
  switch (code) {
    case "superseded_by_appointment_change":
      return "The appointment moved before this went out. Nothing was sent, and that was right.";
    case "transport_not_configured":
      return "Email sending is not configured on this deployment, so nothing could be attempted.";
    case "app_origin_not_configured":
      return "The application origin is not configured, so the link in this message could not be built. Nothing was sent rather than a link to the wrong site.";
    case "credential_not_issued":
      return "The sign-in credential this message carries could not be issued, so the message would have been useless.";
    case "job_missing":
      return "The job this message is about no longer exists.";
    case "agency_missing":
    case "agency_no_longer_on_job":
    case "agency_no_longer_on_invoice":
      return "The agency this was addressed to is no longer on the record.";
    case "agency_deactivated":
    case "customer_deactivated":
      return "The account this was addressed to has been deactivated.";
    case "approved_address_changed":
      return "The address changed after somebody approved the send, so it was not sent to the new one. Approve it again if that is still right.";
    case "payer_missing":
      return "The payer on this invoice is no longer on the record.";
    case "unknown":
      return "The email provider refused it or could not be reached, and gave no reason we recognise.";
    default:
      return `Not sent (${code}). Search the logs for that code.`;
  }
}

// ---------------------------------------------------------------------------
// What a retry can actually promise
// ---------------------------------------------------------------------------

/**
 * How long Resend retains an idempotency key: **24 hours** from first use.
 *
 * Inside that window, the same key with the *same* payload returns the original
 * response instead of sending again, and the same key with a *different*
 * payload is refused (409 `invalid_idempotent_request`). Outside it the key is
 * forgotten and a retry is simply a new request.
 */
export const PROVIDER_IDEMPOTENCY_HOURS = 24;

/**
 * Message kinds that mint a **new credential on every attempt**.
 *
 * Their content therefore changes each time, so they are keyed on the
 * credential rather than on the row and no de-duplication is possible — which
 * is the one thing about this we can state with certainty, because it is a
 * property of our own code rather than of the provider's memory.
 */
const REGENERATES_CREDENTIAL = new Set([
  "tenant-scheduling-invitation",
  "account-invitation",
  "account-password-reset",
]);

/** Kinds whose link is an account credential rather than a scheduling link. */
const ACCOUNT_CREDENTIAL = new Set([
  "account-invitation",
  "account-password-reset",
]);

export type RetryDuplicationRisk =
  /**
   * A new link is minted, so this is a genuinely different message.
   *
   * Certain, because it follows from how the message is built.
   */
  | "new_credential"
  /**
   * The provider's window **cannot yet have closed**, so de-duplication may
   * apply — if the content is unchanged, which is not something the stored row
   * can establish.
   */
  | "window_open_content_unknown"
  /**
   * The window **may** have closed. The first attempt could have been long
   * enough ago that the provider has forgotten the key.
   */
  | "window_may_have_passed";

/**
 * Which case a retry of this row falls into.
 *
 * **What the stored evidence can and cannot support.** An earlier version read
 * `updatedAt` as "when the provider first saw this key". It is not: it moves on
 * every claim, every failed attempt and the retry itself, so a message whose
 * first attempt was a fortnight ago reports as freshly attempted. Worse, it
 * moved the wrong way — the more a message had been retried, the more recent it
 * looked, and the more confident the sentence became.
 *
 * `createdAt` is the only sound bound available. The first attempt cannot have
 * happened before the intent was recorded, so:
 *
 * - **recorded less than 24 hours ago** → whenever the provider first saw the
 *   key, it still remembers it. De-duplication *may* apply.
 * - **recorded longer ago** → the first attempt might have been at any point
 *   since, including outside the window. Nothing can be promised.
 *
 * Even in the first case the answer is "may": Resend de-duplicates on the key
 * **and a matching payload**, and whether the content is byte-identical to the
 * earlier attempt is not something an outbox row records. An address, an
 * appointment time or an invoice line could have changed underneath it. So the
 * strongest honest word is *unlikely*, never *will not*.
 *
 * Nothing here is exactly-once delivery and nothing describes it as such.
 */
export function retryDuplicationRisk(input: {
  kind: string;
  /** When the intent was recorded. A lower bound on the first attempt. */
  createdAt: Date;
  now: Date;
}): RetryDuplicationRisk {
  if (REGENERATES_CREDENTIAL.has(input.kind)) return "new_credential";

  const elapsedHours =
    (input.now.getTime() - input.createdAt.getTime()) / (60 * 60 * 1000);

  return elapsedHours < PROVIDER_IDEMPOTENCY_HOURS
    ? "window_open_content_unknown"
    : "window_may_have_passed";
}

/**
 * The same answer, in a sentence for the person pressing the button.
 *
 * The credential sentences describe what the recipient will actually find,
 * which is **not** "only the newest link works". Both token systems
 * deliberately keep earlier links alive — a first attempt that reported a
 * timeout may well have arrived, and invalidating its link would break
 * something somebody is already holding.
 */
export function retryOutlook(input: {
  kind: string;
  createdAt: Date;
  now: Date;
}): string {
  switch (retryDuplicationRisk(input)) {
    case "new_credential":
      return ACCOUNT_CREDENTIAL.has(input.kind)
        ? "This message carries a sign-in link, and a retry mints a new one. If an earlier attempt did arrive, the recipient will have more than one message — every link still works until one of them is used, and using any one retires the rest."
        : "This message carries a booking link, and a retry mints a new one. If an earlier attempt did arrive, the recipient will have more than one message — every link still works until it expires, and they all lead to the same appointment.";
    case "window_open_content_unknown":
      return `This was queued less than ${PROVIDER_IDEMPOTENCY_HOURS} hours ago, so the provider should still recognise it. A second copy is unlikely, though not impossible: the provider only ignores a repeat whose content is identical, and nothing here records whether it is.`;
    case "window_may_have_passed":
      return `This was queued more than ${PROVIDER_IDEMPOTENCY_HOURS} hours ago, so the provider may no longer recognise it. If an earlier attempt was in fact accepted, this may produce a second copy.`;
  }
}
