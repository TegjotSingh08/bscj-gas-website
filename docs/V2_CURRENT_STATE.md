# V2 — current state

**Read this first.** It exists so a new session does not have to re-audit the
repository. Update it at the end of every piece of work.

Last updated: 16 September 2026.

---

## Current milestone

**V2.0 Foundation — complete. V2.1 Portfolio is next.**

## Where the code is

`main` is at `6bd7c91`. The branch `v2-compliance-platform` still has **no
commits**: everything below is an uncommitted working-tree change.

**Nothing about V2 is deployed, and no migration has been applied** —
`DATABASE_URL` is set nowhere, including production. `0000` was therefore
reshaped in place rather than corrected by follow-up migrations. That freedom
ends the first time it runs against real data.

### V2.0, as built

| Area | Files | State |
| --- | --- | --- |
| Schema | `src/lib/db/schema.ts` | **22 tables.** Reshaped for agent accounts before first migration |
| Migrations | `drizzle/0000_v2_foundation.sql`, `0001_invoice_number_sequence.sql`, both with down files | Regenerated, reviewed, unapplied |
| Database client | `src/lib/db/client.ts`, `index.ts` | Neon HTTP + Drizzle, lazy, null-safe |
| Roles and permissions | `src/lib/auth/roles.ts` | Capability matrix for the four roles |
| Organisation scoping | `src/lib/auth/scope.ts` | Scope derivation, access checks, query filter |
| User lookup | `src/lib/auth/app-user.ts` | One table for staff and agency users |
| Session guards | `src/lib/auth/session.ts` | `requireAdmin` / `requireAgent` / `requireEngineer`, DB-derived |
| Auth wiring | `src/auth.ts`, `src/types/next-auth.d.ts` | Auth.js, token carries id only as authority |
| Middleware | `src/middleware.ts` | Gates `/admin`, `/portal`, `/engineer` and their APIs |
| Job lifecycle | `src/lib/jobs/lifecycle.ts` | Nine statuses, transitions enumerated |
| Derived job state | `src/lib/jobs/derived.ts` | Stage, deadline risk, needs-attention |
| Job references | `src/lib/jobs/reference.ts` | Now refuses all-digit, so it cannot look like an invoice number |
| Renewal rule | `src/lib/compliance/renewal.ts` | +12 months − 1 day, one implementation |
| Pricing | `src/lib/pricing/tiers.ts`, `resolve.ts`, `snapshot.ts` | Tiers, resolution, frozen snapshot |
| Invoice numbering | `src/lib/invoices/number.ts`, `allocate.ts` | `BSCJ-000001`, from a Postgres sequence |
| Business identity | `src/lib/settings/business-identity.ts`, `store.ts` | Configurable identity, VAT off, nothing invented |
| Admin shell | `src/app/admin/**` | Placeholder dashboard + login, on the new session module |
| Staff tool | `scripts/create-admin.mjs` | Creates an admin or an engineer |

### Not started

Everything else. No portfolio screens, no agent job creation, no tenant
scheduling, no engineer UI, no certificate or invoice generation, no cron, no
blob storage, no messaging UI.

## Completed work

- Full repository audit (16 September 2026)
- V2 product spec, architecture and implementation plan written
- **V2.0 Foundation**: schema reshaped and regenerated, unified auth with
  roles and organisation scoping, and the domain rules — renewal, pricing,
  invoice numbering, business identity — as pure tested modules

## Next task

**V2.1 Portfolio.** The schema and the guards are in place, so this is screens
and queries: `/portal` shell and sign-in, landlords, properties, tenancies, and
a property detail page.

Two things to do first, in this order:

1. **Configure Neon and apply `0000` to a branch.** Nothing in V2.1 can be
   verified against a database that does not exist. Set `DATABASE_URL`, run
   `npm run db:migrate`, then `npm run admin:create` for a first administrator.
2. **Route every portfolio read through `organisationCondition`** from
   `lib/auth/scope.ts`. A handler that builds its own `WHERE` is the failure
   mode the whole design is arranged to make hard.

## Major decisions

1. **Extend the existing Next.js monolith.** No new service, no queue broker,
   no separate API. See `V2_ARCHITECTURE.md` § "Why nothing new was added".
2. **Postgres is the operational record; Google Calendar stays scheduling;
   Resend stays communication.**
3. **The code product registry keeps the public list price. Agent pricing is a
   separate database layer that overrides it for agent jobs only.** The £45
   consumer CP12 is untouched by anything an agent negotiates.
4. **Certificate Issued and Invoiced are derived, not lifecycle statuses.**
   A job can be completed, certificated and invoiced at once; one enum cannot
   say that. `lib/jobs/derived.ts`.
5. **Deadline risk is computed, never stored.**
6. **Tenant sessions are not Auth.js.** A path-scoped, short-lived signed
   cookie carrying a job id and nothing else. Not built yet (V2.3).
7. **The CP12 generator and the invoice generator are reused, not rebuilt.**
8. **V1's `/api/book` gains exactly one new step** — a best-effort persistence
   write that cannot fail a booking. **Not yet written**; it moved from V2.0 to
   V2.1 because it needs a live database to be verifiable.
9. **One user table, not two.** `app_user` holds BSCJ staff and agency users.
   A second login path is a second place to get password comparison, timing and
   deactivation subtly wrong.
10. **The session token identifies the user and nothing more.** Role and
    organisation are re-read from the database on every request, so
    deactivating an account takes effect immediately rather than in eight
    hours.
11. **An engineer is scoped by assignment, not by organisation.** Modelling one
    as an organisation-less admin would hand them everyone's data.
12. **A tenancy, not a tenant.** An occupancy with a period, so a new tenant
    does not erase who we actually contacted last year.
13. **An invoice is a header plus lines.** The only shape a consolidated
    monthly agent invoice fits in.
14. **Issued certificates are versioned, never updated.** A correction is a new
    row pointing at the one it supersedes.
15. **`activity` and `audit_event` are separate tables.** One is the agent's
    timeline; the other is the security log.

## Blocker decisions — resolved 16 September 2026

| # | Decision | Where it lives |
| --- | --- | --- |
| 1 | **Renewal** = inspection date + 12 months − 1 day | `lib/compliance/renewal.ts`, one implementation, tested |
| 2 | **VAT**: BSCJ is *not* registered. Modelled in full, switched off, no VAT wording rendered | `lib/settings/business-identity.ts`, `invoice.vat_*` |
| 3 | **Invoice numbers**: new `BSCJ-000001` series from a Postgres sequence. The `D-` series is not continued | `lib/invoices/number.ts`, `drizzle/0001` |
| 4 | **Identity is configuration**, not code: display name, legal entity, company number, address, contact, footer, VAT — all settings, snapshotted onto each invoice | `lib/settings/business-identity.ts`, `invoice.identity_snapshot` |
| 5 | **Volume tiers** committed in advance per month; bands 1-14 … 100+; prices per service and tier, agent overrides supported; price frozen on the job | `lib/pricing/*`, `volume_commitment`, `pricing_agreement_line` |
| 6 | **Generators** are reused, not rebuilt. Integration is V2.5 | — |

## Still open — need BSCJ input

1. **Agent pricing figures.** The tier *mechanism* is built and tested; no
   figures are in the code. The 75-at-£39.99 example in the brief is an
   illustration and has not been entered anywhere. Nothing can be quoted to an
   agent until real numbers are approved. *(Needed for V2.2.)*
2. **Legal entity change.** BSCJ Solutions is expected to be incorporated
   around 4–5 October 2026. Nothing is hard-coded, so this is a settings edit
   when it happens — but the settings are empty and no invoice can be issued
   until they are filled. *(Needed for V2.5.)*
3. **Invoice footer wording and payment terms.** Confirmed as "to be supplied
   separately". `canIssueInvoices()` refuses until they are. *(V2.5.)*
4. **Default remedial authorisation threshold.** £0 — nothing without asking —
   is the implemented default. Confirm it is right for a new account. *(V2.4.)*
5. **Both generators are still untracked**, in `~/Gas Cert Generator/` and
   `~/Invoice Generator/`, on one machine. They should be under version
   control before V2.5 depends on them.
6. **Neon is not provisioned.** Blocks V2.1 verification.

## Known issues, unrelated to V2

- **5 failing tests** in `src/app/api/availability/route.test.ts`. Clock-
  dependent, not a production defect: they ask for the first Wednesday in the
  offered window, get *today*, and today's 15:00 and 16:00 are inside the
  12-hour notice window. They pass when run earlier in the day. Fix by pinning
  a clock — queued for V2.8. 1060 of 1065 tests pass.
- `docs/business-details.md` says "Maximum bookings per day: 8"; the code and
  `CLAUDE.md` both say ten. The code is authoritative; the doc is stale.
- `BOOKING_NOTIFICATION_EMAIL` is in `.env.example` but not in `.env.local`,
  so internal booking alerts are silently not sent in development.
