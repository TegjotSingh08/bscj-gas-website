/*
  When a submission attempt claimed the job.

  One nullable column on a table added by 0010. Additive: nothing is altered,
  no default is written to existing rows, and no row is read or rewritten.

  A row that predates this has a NULL here, which the application reads as "no
  lease recorded" and treats as recoverable — the safe direction, because the
  alternative is an engineer stuck for ever on a claim nobody can clear.
*/
ALTER TABLE "certificate_draft" ADD COLUMN "submission_started_at" timestamp with time zone;