/*
  The address an administrator actually approved.

  Until now `outbound_email.recipient` held a *role* — "agent", "customer" —
  and the worker resolved it to an address when it sent. That is right for a
  tenant invitation, where the address is whatever is current and nobody
  approved anything in particular. It is wrong for a certificate.

  Releasing a gas safety record is a deliberate act: an administrator reads
  the document, sees the resolved addresses on screen, and chooses. If the
  agency's address is edited in the minutes or hours before the outbox runs,
  re-resolving would send an approved document to an address nobody
  approved — silently, with no record that the destination changed.

  So the approved address is frozen here, in the same row as the intent,
  written in the statement that queues it. At send time the worker uses this
  value and separately re-checks that the recipient is *still* entitled to
  the document; a change of address no longer redirects the send, and a
  change of entitlement stops it and flags it for review.

  Nullable, because every existing kind still resolves at send time and
  every existing row predates the column. A NULL means "resolve as before",
  which is exactly what those rows have always done.

  Additive and non-destructive. One nullable column, no index: it is never
  a filter — rows are found by state, kind and lease, and this is read only
  once a row has already been claimed.
*/
ALTER TABLE "outbound_email" ADD COLUMN IF NOT EXISTS "recipient_address" text;
