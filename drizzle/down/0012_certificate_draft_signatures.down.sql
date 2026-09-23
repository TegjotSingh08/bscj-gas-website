-- Reverses 0012.
--
-- Drops the captured signatures from `certificate_draft`.
--
-- **What is lost.** Marks drawn against drafts that have not been submitted.
-- The engineer signs again; nothing else about the draft is affected.
--
-- **What is not lost.** Every signature on a record that has been submitted.
-- A submitted record is a PDF in `document` with the signatures already drawn
-- into it, and a released one is a `certificate` pointing at that same PDF.
-- Neither is touched here, and no image is read back out of this column to
-- produce them.
--
-- **Code and schema during a rollback.** Running this while the application
-- still expects the column will break every certificate draft save — the
-- query names `signatures` explicitly. Roll the application back first, or
-- together. In the other direction the column is harmless: an older build
-- ignores it, and it stays NULL.

ALTER TABLE "certificate_draft" DROP COLUMN IF EXISTS "signatures";
