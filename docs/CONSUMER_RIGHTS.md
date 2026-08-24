# Consumer rights and the booking contract

Why the booking flow asks what it asks, and where each rule comes from.

> **This is not legal advice and has not been reviewed by a solicitor.** It is a
> record of primary-source research done on 22 August 2026 so that a later
> reader can check the reasoning rather than take it on trust. A solicitor
> should review the wording before the business relies on it — particularly the
> regulation 36 acknowledgement and the regulation 14 button labelling.

Terms version in force: **2026-08-24** (`TERMS_VERSION` in
`src/lib/booking/terms.ts`).

**Version history.** `2026-08-22` was the first version under this research.
`2026-08-24` added §5a, the inspection-versus-remedial-work clause: the £45 is
the charge for carrying out the inspection and applies whatever it finds;
repairs, parts and remedial work are excluded, separately agreed and separately
invoiced; and the customer is under no obligation to use BSCJ for them. That is
a change of substance to the contract, so the version was bumped and stale
versions are rejected server-side. Nothing about the cancellation regime, the
regulation 36 mechanism or the reg 14 button labelling changed.

---

## 1. Sources

All accessed **22 August 2026**.

| Source | URL |
| --- | --- |
| Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 | https://www.legislation.gov.uk/uksi/2013/3134 |
| — reg 13, information before a distance contract | https://www.legislation.gov.uk/uksi/2013/3134/regulation/13/made |
| — reg 14, contracts concluded by electronic means | https://www.legislation.gov.uk/uksi/2013/3134/regulation/14/made |
| — reg 16, confirmation on a durable medium | https://www.legislation.gov.uk/uksi/2013/3134/regulation/16/made |
| — reg 27, application of the cancellation Part | https://www.legislation.gov.uk/uksi/2013/3134/regulation/27 |
| — reg 28, exceptions to the cancellation right | https://www.legislation.gov.uk/uksi/2013/3134/regulation/28/made |
| — reg 30, the cancellation period | https://www.legislation.gov.uk/uksi/2013/3134/regulation/30/made |
| — reg 31, extension where information is not given | https://www.legislation.gov.uk/uksi/2013/3134/regulation/31/made |
| — reg 32, how the consumer cancels | https://www.legislation.gov.uk/uksi/2013/3134/regulation/32/made |
| — reg 36, services supplied in the cancellation period | https://www.legislation.gov.uk/uksi/2013/3134/regulation/36 |
| — Schedule 2, information required | https://www.legislation.gov.uk/uksi/2013/3134/schedule/2/made |
| — Schedule 3, model instructions and cancellation form | https://www.legislation.gov.uk/uksi/2013/3134/schedule/3/made |
| BIS official guidance on the 2013 Regulations | https://assets.publishing.service.gov.uk/media/5a817b92ed915d74e33fe73a/bis-13-1368-consumer-contracts-information-cancellation-and-additional-payments-regulations-guidance.pdf |
| Consumer Rights Act 2015, Part 1 Chapter 4 (services) | https://www.legislation.gov.uk/ukpga/2015/15/part/1/chapter/4 |
| Consumer Rights Act 2015, Part 2 (unfair terms) | https://www.legislation.gov.uk/ukpga/2015/15/part/2 |
| CMA37, *Unfair contract terms*, **22 July 2026 edition** | https://assets.publishing.service.gov.uk/media/6a609329b00f3323bf1a23f3/unfair_contract_terms_guidance.pdf |
| Digital Markets, Competition and Consumers Act 2024, s279 | https://www.legislation.gov.uk/ukpga/2024/13/section/279 |

**Correction to earlier project documentation.** The research recorded on
21 August 2026 cited the 2015 edition of CMA37. That edition has been replaced
by a **new CMA37 dated 22 July 2026**, which is the version relied on here. Its
paragraph numbering differs, and its treatment of termination fees (6.63–6.67)
is more detailed. The conclusions did not change, but the citation did.

---

## 2. Does the regime apply?

**Yes.** A booking taken through this website is a *distance contract* for a
*service* between a trader and, usually, a consumer.

- **Still in force.** legislation.gov.uk shows the 2013 Regulations up to date
  with all changes in force on or before 21 August 2026.
- **DMCCA 2024 does not disapply them here.** Section 279 inserts reg 7(4A) and
  reg 27(3A), which exclude *subscription contracts* from Parts 2 and 3. A
  one-off CP12 booking is not a subscription contract.
- **No reg 28 exception applies.** The two that might look close do not:
  - *reg 28(1)(e), urgent repairs or maintenance requested by the consumer* — a
    scheduled annual compliance inspection is neither urgent nor a repair. The
    official guidance frames this as being "called to a home to effect emergency
    repairs".
  - *reg 28(1)(h), leisure services with a specific date* — the guidance gives
    car hire, wedding venues and theatre tickets. A gas safety inspection is not
    a leisure activity.

---

## 3. The cancellation period

Regulation 30(2)(a): for a service contract the cancellation period **ends at
the end of 14 days after the day on which the contract is entered into**.

Implemented in `cancellationPeriodLastDate()`, counting on the local calendar
date in Europe/London so the hour of booking makes no difference, and tested
across both daylight-saving transitions and a year end.

**Regulation 31 is the reason this matters so much.** If the information on the
right to cancel is not given, the cancellation period extends by up to
**12 months**. Getting the confirmation email wrong does not cost 14 days of
exposure; it costs a year.

---

## 4. Starting work inside the cancellation period

Bookings are taken from 12 hours to 30 days ahead, so **most appointments fall
inside the 14 days**. Two distinct requirements apply.

**Regulation 36(1)** — the trader must not begin supplying the service before
the end of the cancellation period unless the consumer *"has made an express
request"*. Sub-paragraph (b) requires that request to be on a durable medium
only *"in the case of an off-premises contract"*. This is a distance contract,
so an on-screen tick is sufficient. The official guidance confirms this
directly, answering a trader selling services online: *"No. Only the early start
of services under off-premises contracts require the consumer's express request
to be made on a durable medium."*

**Regulation 36(2)** — the consumer ceases to have the right to cancel if the
service *"has been fully performed"*, and performance began **(a)** after a
request under 36(1), **and (b)** *"with the acknowledgement that the consumer
would lose that right once the contract had been fully performed by the
trader"*.

**Regulation 36(4)–(6)** — cancel part-way and the consumer pays a proportionate
amount for what was supplied. But under **36(6)** the consumer bears **no cost
at all** if the required information was not given, or if the service was not
supplied in response to the consumer's request.

### What this means commercially

Without a properly obtained express request and acknowledgement, a customer
could have the certificate issued and then cancel inside 14 days owing
**nothing** — the engineer's time, the travel and the certificate, all
unrecoverable. This is the single largest exposure the terms milestone had to
close.

### How it is implemented

One separate, unticked control, shown **only** when the appointment falls inside
the period. It carries both the 36(1) request and the 36(2)(b) acknowledgement,
plus the 36(4) proportionate-payment consequence, because all three describe the
same decision. It is never bundled with the terms tick.

Whether the control is *required* is recomputed on the server in
`requiresEarlyPerformanceRequest()` from the slot and the moment of booking. The
browser sends only whether the customer ticked it.

---

## 5. Information requirements

**Regulation 13(1)(a)** — the Schedule 2 information must be given or made
available before the consumer is bound. Schedule 2 includes (f) the total price,
(l) the conditions, time limit and procedures for cancelling, (n) the
consumer's liability for costs where they asked for the service to begin, and
(o) where the cancellation right does not exist or may be lost.

**Regulation 13(1)(b)** — where a right to cancel exists the trader **must give
or make available a cancellation form as set out in Part B of Schedule 3**. The
official guidance accepts a link for distance contracts: *"make available (e.g
by giving a link) a model cancellation form"*. Provided at
`/terms#cancellation-form`.

**Regulation 13(6)** — information given under reg 13 is treated as a term of
the contract. Which is why the terms are versioned.

**Regulation 32(2)–(3)** — the consumer may use the model form *or* make *"any
other clear statement setting out the decision to cancel"*. The terms and the
email both say the form is optional. Never imply otherwise.

---

## 6. Regulation 14 — the obligation to pay

**This was missed by the earlier research and is a real finding.**

Regulation 14 applies to distance contracts concluded by electronic means where
the order entails an obligation to pay. It requires that the consumer, when
placing the order, **explicitly acknowledges that the order implies an
obligation to pay**, and that where the order is placed with a button, the
button is labelled *"order with obligation to pay"* **or a corresponding
unambiguous formulation**.

If the trader fails to comply, **"the consumer is not bound by the contract or
order"**.

The official guidance is explicit that deferred payment does not remove the
requirement: *"For online sales the consumer must explicitly acknowledge any
obligation to pay. (For example, a button that says 'pay now'). This is the
case, even if taking payment is to be deferred."* BSCJ takes payment after the
visit, so this applies squarely.

Guidance also requires the main characteristics and total price to be *"clear
and prominent, directly before the consumer places their order"*.

### How it is implemented

- The confirm button reads **"Confirm booking — agree to pay £45"** (the figure
  is the server-derived total, so it tracks extra appliances).
- Directly above it, a prominent line states that confirming creates a contract
  and an obligation to pay, and that payment is after completion.
- The review card already shows the service and the total immediately above.

A fourth checkbox was deliberately *not* added: reg 14(4) makes the button
label the mechanism for a button-placed order, and stacking another tick would
add friction without adding compliance.

---

## 7. Regulation 16 — confirmation on a durable medium

The trader must give confirmation of the contract **on a durable medium**,
including the Schedule 2 information unless already provided on a durable
medium, and **before performance begins**.

The official guidance is decisive on what counts:

> *"An email is a durable medium. However, information contained via link to a
> website which may change, and which is embedded in an email is not."*

So a confirmation email that merely links to `/terms` would **not** discharge
the obligation. The cancellation information is therefore written into the email
body itself — both the HTML and the plain-text parts — including the 14-day
right, the exact expiry date, how to cancel, the early-start position, the
proportionate-payment rule, the total price and the terms version.

---

## 8. Consumer Rights Act 2015

- **s49** — the service must be performed with reasonable care and skill.
- **s50** — information said or written about the trader or the service becomes
  a contract term where the consumer takes it into account.
- **s51/s52** — reasonable price and reasonable time where not fixed.
- **s54–s56** — remedies: repeat performance, then price reduction.
- **s57** — liability under s49 **cannot be excluded or restricted**, and cannot
  be limited to less than the contract price.

The terms therefore state these rights and expressly do not exclude them.
Liability for death or personal injury from negligence, and for fraud, is not
excluded either.

**Part 2, unfair terms** — s62 fairness test (significant imbalance contrary to
good faith), s64 (a price or main-subject-matter term escapes assessment only if
transparent and prominent), s68 transparency, s69 contra proferentem, and
Schedule 2's grey list — paragraph 5 (disproportionately high sums in
compensation) and paragraph 6 (cancellation penalties).

---

## 9. Why there is no cancellation charge

CMA37 (22 July 2026), paragraph 6.63, treats a term as likely unfair where it
requires a payment for ending the contract early that does not appropriately
reflect:

- savings for the business from no longer having to provide the service,
- **the business's ability to mitigate the loss, for instance by finding
  another customer**, and
- any benefit of receiving payment earlier.

Paragraph 6.64: a termination fee is more likely to be fair where it is a stated
sum representing *"a genuine pre-estimate of loss"*, with *"no circumstances in
which they are likely to be disproportionate or punitive"*. Paragraph 6.65 adds
that the consumer should be able to avoid the sanction easily and should have
obtained a clear benefit by accepting the term.

Applied to a 45-minute CP12 slot:

- the slot is readily resold, and the booking system returns it to availability
  the moment it is released, so mitigation is close to complete;
- BSCJ incurs no unavoidable cost on a cancellation — no parts, no prepaid
  travel;
- most cancellations fall inside the statutory window, where an unperformed
  service costs the consumer nothing anyway;
- **no payment method is held**, so collecting £5 would cost more than £5.

**Conclusion: no flat £5 charge, no automatic £45 no-show charge, no sliding
scale.** Revisit only with evidence of actual direct loss, and only with a
transparent, prominent, proportionate figure.

The same reasoning drives the **failed-access** policy: one free reschedule, and
for repeat failures BSCJ declines to keep rebooking online rather than inventing
a penalty. Refusing further service is proportionate; an arbitrary charge is not.

---

## 10. What was wrong with the previous terms

The `/terms` page in force until this milestone said:

> *"Cancellations require at least 48 hours' notice. Appointments cannot be
> cancelled inside that window."*

As written that purported to remove the statutory cancellation right inside a
48-hour window. Under CRA 2015 s57 and s62 that is not something a trader can
do, and Schedule 2 paragraph 6 lists cancellation penalties on the grey list.
The page also had **no** statement of the 14-day right, no reg 36 request, no
reg 13(1)(b) cancellation form, and no version.

That wording is gone. A test now fails the build if "cannot be cancelled" or
similar reappears anywhere under `src/`.

---

## 11. Consumers versus business customers

The booking form asks whether the customer is a landlord, letting agent, tenant
or homeowner — for operational reasons, not legal classification.

The 2013 Regulations and CRA 2015 protect *consumers*: individuals acting wholly
or mainly outside a trade, business, craft or profession. A letting agent, and
often a landlord, will be acting in the course of a business and so will not be
a consumer. The line is genuinely uncertain for a single "accidental" landlord.

**Decision for V1: do not classify.** Everyone gets the consumer-protective
flow. Getting classification wrong in the other direction — stripping statutory
rights from someone who turns out to be a consumer — is the far worse failure,
and reg 31 punishes it with a 12-month cancellation window. Applying the
protections to a business customer who did not strictly need them costs nothing.
The terms say the statutory rights apply "if you are a consumer".

Revisit only if a genuine commercial need appears, and never by adding a
classification questionnaire to the booking form.

---

## 12. Open points for a solicitor

1. **The reg 36 wording.** The control carries the request and the
   acknowledgement in one statement. That reads naturally to a customer and
   covers both statutory elements, but a solicitor should confirm it.
2. **Reg 14 button label.** "Confirm booking — agree to pay £45" is offered as a
   "corresponding unambiguous formulation". It has not been tested in court.
3. **Consumer status of landlords** (§11).
4. **Complaints routing.** The terms point to Citizens Advice and the Gas Safe
   Register. BSCJ belongs to no ADR scheme; whether one is needed has not been
   assessed.
5. **CMA37 is newly revised** (22 July 2026). Interpretation of the new edition
   is not yet settled.
6. **ICO registration.** Not confirmed, and `icoRegistrationNumber` is still
   `null`. Whether registration is required has not been assessed.
