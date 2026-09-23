/*
  The signatures captured on an engineer's gas safety record.

  One nullable column on a table added by 0010. Additive: nothing is altered,
  no default is written to existing rows, and no row is read or rewritten.

  A row that predates this has NULL here, which the application reads as
  "nothing has been signed yet" — the only honest reading, and the safe one.

  It is a column rather than a member of `fields` because a signature is not a
  field: it is an image, it is far larger than the per-field cap, and it
  carries the hash of the fields it was put against so that editing the record
  removes the mark instead of silently keeping it.
*/
ALTER TABLE "certificate_draft" ADD COLUMN "signatures" jsonb;
