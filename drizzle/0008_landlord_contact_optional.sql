/*
  A landlord may be known before their contact details are.

  Two columns relax from NOT NULL to nullable. Nothing is dropped, no data is
  rewritten, no existing value changes, and every populated record stays
  exactly as it is.

  **Why.** An agency's portfolio export routinely names the owner of a property
  and carries no email or phone for them. Until now `customer.email` and
  `customer.phone` were NOT NULL, so such a property could not be recorded at
  all: the only ways through were inventing a contact — which puts a fiction in
  front of a landlord and eventually into an invoice — or refusing the whole
  import. Both are worse than recording what is actually known.

  Three things this deliberately does **not** do:

  1. **`property.customer_id` stays NOT NULL.** A property still belongs to an
     identified owner. This relaxes what we know *about* the owner, never
     whether there is one — a property whose ownership is genuinely unknown
     stays unresolved rather than being attached to a placeholder.

  2. **It does not make contact optional everywhere.** It moves the
     requirement from the moment of *recording* to the moment of *acting*: an
     operation that has to reach somebody — emailing a certificate, delivering
     an invoice — still requires an address for the recipient it actually
     chose, and refuses by name when there is none. Recording a property needs
     no such thing.

  3. **It does not affect consumer bookings.** The public booking flow collects
     an email and a phone and validates both before a job exists; those go on
     to the same table, and nothing here relaxes that path. The nullability is
     for records created from an agency's portfolio.

  A blank contact must never make two landlords look like one. The application
  matches on a **non-empty** email within an organisation, so two rows with no
  email do not collide; a partial unique index would express that in the
  database too, but the existing `customer_email_idx` is deliberately
  non-unique — an agency and a private customer may legitimately share an
  address — so the rule stays where it already lives, in `createLandlord`.
*/

ALTER TABLE "customer" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ALTER COLUMN "phone" DROP NOT NULL;
