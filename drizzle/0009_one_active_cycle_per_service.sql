/*
  One active compliance position per property, per service.

  **Additive and enforcing only.** No column is added, dropped or rewritten, no
  data changes, and nothing existing is reinterpreted. It makes the database
  refuse a state the application already treats as impossible.

  **Why.** `compliance_cycle` records what a property's renewal position is, and
  the application supersedes the active one and inserts a replacement inside a
  single batch. That is correct in isolation and it is not enough: two requests
  arriving together — a release and a retry, two administrators, a double
  submit — can each read "no active cycle", each insert one, and leave the
  property with two active positions for the same service. Every screen then
  shows whichever the query happens to return first, and no amount of reading
  the rows tells you which is right.

  A partial unique index is the smallest thing that makes it impossible. The
  loser of the race gets a unique-violation and the application's existing
  handling reports it, rather than both winning and the record being wrong.

  **Why it is partial.** Superseded and cancelled cycles are the property's
  history and there are deliberately many of them; only `active` is the
  singular one. A plain unique index would forbid a second year's certificate.

  Compatible with the deployed application, which never intends two active
  cycles for one service and now has the rule enforced under it rather than
  only in front of it.

  **Before applying, check nothing already violates it:**

      SELECT property_id, product_id, count(*)
      FROM compliance_cycle
      WHERE status = 'active'
      GROUP BY property_id, product_id
      HAVING count(*) > 1;

  That must return no rows. If it returns any, decide which position is correct
  and supersede the others by hand — do not delete them, and do not let this
  migration choose on your behalf.
*/

CREATE UNIQUE INDEX "compliance_cycle_one_active_per_service"
  ON "compliance_cycle" ("property_id", "product_id")
  WHERE "status" = 'active';
