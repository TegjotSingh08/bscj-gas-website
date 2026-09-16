/*
  Invoice numbers.

  Hand-written rather than generated, because a sequence is not something a
  schema diff can express — and because the alternative implementations are all
  wrong. Counting existing rows races; a "last number" column races unless every
  reader takes a lock; a timestamp is not a number a business can account for.
  A Postgres sequence is atomic by construction and never reissues a value,
  even when a transaction that drew one rolls back. Gaps are therefore expected
  and are not a fault.

  V2 runs its own series, `BSCJ-000001` upwards, starting at one — confirmed by
  BSCJ on 16 September 2026. The old hand-maintained `D-…` series belonging to
  the standalone invoice generator is deliberately not continued: two systems
  incrementing one series is how two invoices end up sharing a number.

  The prefix and the six-digit formatting live in `lib/invoices/number.ts`, not
  here. A sequence produces a number; what it is called is the application's.
*/
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  NO CYCLE;
