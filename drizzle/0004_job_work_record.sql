/*
  What happened on the visit, recorded on the job.

  Until now a job went from `scheduled` to `completed` with nothing between
  them and nothing kept about either moment. The engineer's own account of the
  visit lived in a phone call, and "when did they actually start" could only
  be guessed from the appointment time — which is the one thing that is
  reliably wrong on a busy day.

  Two nullable columns, both written by the engineer's own actions and by
  nothing else:

  - `work_started_at` — when the engineer said they were on site. The timeline
    records the event as well; this column is what lets a list show it without
    reading every activity row for every job on the page.
  - `completion_notes` — what they found, in their own words. Free text, and
    deliberately so: nothing parses it and nothing downstream reads a fact out
    of it. It is not a certificate, it does not stand in for one, and no
    commercial or compliance rule may be derived from it.

  Additive and non-destructive. No index: neither column is ever a filter —
  the lifecycle status already answers "has this started" and "is this done",
  and indexing a free-text note would only invite querying it as if it meant
  something. Every existing row keeps the behaviour it already had; NULL here
  means "not recorded", which is true of every job written before this.
*/
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "work_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "completion_notes" text;
