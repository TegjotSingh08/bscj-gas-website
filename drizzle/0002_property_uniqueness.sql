/*
  One property, one row, per agency.

  A server-side check before insert catches the ordinary case — an agent
  adding the same house twice — but two submissions racing each other both
  see "not there" and both write. A unique index is the only thing that makes
  the guarantee hold under concurrency, and a portfolio that quietly contains
  the same property twice produces two CP12 jobs, two invoices and two renewal
  cycles for one address.

  Partial, on `agent_organisation_id IS NOT NULL`, for two reasons:

  - consumer bookings have no organisation, and two households at the same
    postcode legitimately produce separate rows with the same house number;
  - a repeat website booking for the same address is matched by the persistence
    code before it inserts, so it never reaches this index.

  `lower(house_or_name)` because "Flat 2a" and "Flat 2A" are the same flat.
  The postcode is already stored canonically uppercase.

  Additive and non-destructive. It creates no table and drops nothing; if it
  fails, an existing duplicate is the reason and that is worth knowing.
*/
CREATE UNIQUE INDEX IF NOT EXISTS "property_org_address_key"
  ON "property" ("agent_organisation_id", "postcode", lower("house_or_name"))
  WHERE "agent_organisation_id" IS NOT NULL;
