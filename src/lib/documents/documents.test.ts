import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkPdf,
  MAX_DOCUMENT_BYTES,
  MIN_DOCUMENT_BYTES,
  safeDocumentFilename,
} from "./validate";
import {
  canUploadCertificate,
  CERTIFICATE_RECIPIENTS,
  checkRelease,
  isCertificateRecipient,
  uploadRefusal,
} from "./release";
import {
  approvalFromKey,
  certificateFromKey,
  certificateKey,
  certificateRows,
} from "@/lib/notifications/kinds";

/**
 * Documents: what is accepted, what is released, and who is told.
 *
 * The behavioural half is here; the structural guards at the bottom cover
 * the things a later edit could quietly undo — an access check that stops
 * distinguishing released from uploaded, a query that drops its
 * organisation filter, a route that starts trusting a header.
 */

// A minimal well-formed PDF: the magic bytes, some filler, and %%EOF.
function pdf(bytes = MIN_DOCUMENT_BYTES + 100): Uint8Array {
  const out = new Uint8Array(bytes);
  for (const [i, ch] of [..."%PDF-1.4"].entries()) out[i] = ch.charCodeAt(0);
  out.fill(0x20, 8, bytes - 6);
  for (const [i, ch] of [..."%%EOF\n"].entries()) out[bytes - 6 + i] = ch.charCodeAt(0);
  return out;
}

describe("what may be uploaded", () => {
  test("a well-formed PDF is accepted", () => {
    const result = checkPdf(pdf(), "Gas Certificate.pdf");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.filename, "Gas Certificate.pdf");
  });

  test("something that is not a PDF is refused, whatever it is called", () => {
    /*
      The content type and the extension are both whatever the client says.
      Only the bytes are evidence.
    */
    const jpeg = new Uint8Array(MIN_DOCUMENT_BYTES + 100);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    const result = checkPdf(jpeg, "certificate.pdf");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not a PDF/i);
  });

  test("a truncated PDF is refused", () => {
    // Starts right, never finishes — an interrupted download.
    const cut = pdf().slice(0, MIN_DOCUMENT_BYTES + 50);
    const result = checkPdf(cut, "certificate.pdf");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /incomplete/i);
  });

  test("empty, tiny and oversized files are each refused by name", () => {
    assert.match(
      (checkPdf(new Uint8Array(0), "x.pdf") as { error: string }).error,
      /empty/i,
    );
    assert.match(
      (checkPdf(new Uint8Array(10), "x.pdf") as { error: string }).error,
      /too small/i,
    );
    const huge = pdf(MAX_DOCUMENT_BYTES + 1);
    assert.match((checkPdf(huge, "x.pdf") as { error: string }).error, /limit/i);
  });

  test("a filename cannot become a path or a header", () => {
    assert.equal(safeDocumentFilename("../../etc/passwd", "f.pdf"), "passwd.pdf");
    assert.equal(safeDocumentFilename('a"b\r\nc.pdf', "f.pdf"), "abc.pdf");
    assert.equal(safeDocumentFilename("", "f.pdf"), "f.pdf");
    assert.equal(safeDocumentFilename(null, "f.pdf"), "f.pdf");
    assert.equal(safeDocumentFilename(".pdf", "f.pdf"), "f.pdf");
  });
});

describe("which jobs may carry a certificate", () => {
  test("only once the visit has started", () => {
    for (const status of ["in_progress", "remedial_required", "completed"]) {
      assert.equal(canUploadCertificate(status), true, status);
    }
    for (const status of [
      "draft",
      "tenant_outreach",
      "awaiting_tenant",
      "scheduled",
      "engineer_assigned",
      "cancelled",
    ]) {
      assert.equal(canUploadCertificate(status), false, status);
      assert.ok(uploadRefusal(status), `${status} refuses without saying why`);
    }
  });
});

describe("releasing", () => {
  const good = {
    certificateNumber: "BSCJ-CERT-1",
    inspectionDate: "2026-09-18",
    nextDueDate: "2027-09-17",
    correctionReason: "",
  };

  test("a first release needs a number and both dates", () => {
    const result = checkRelease(good, { isCorrection: false, today: "2026-09-19" });
    assert.equal(result.ok, true);
  });

  test("nothing is defaulted — each field is required", () => {
    /*
      No numbering scheme exists and the renewal rule is deliberately not
      applied here, so every one of these is a person's entry. A blank is a
      refusal, never a value invented on their behalf.
    */
    for (const field of ["certificateNumber", "inspectionDate", "nextDueDate"]) {
      const result = checkRelease(
        { ...good, [field]: "" },
        { isCorrection: false, today: "2026-09-19" },
      );
      assert.equal(result.ok, false, field);
      if (!result.ok) assert.ok(result.errors[field], `${field} has no message`);
    }
  });

  test("a date that is not a date is refused", () => {
    const result = checkRelease(
      { ...good, inspectionDate: "2026-02-30" },
      { isCorrection: false, today: "2026-09-19" },
    );
    assert.equal(result.ok, false);
  });

  test("an inspection cannot be in the future", () => {
    const result = checkRelease(
      { ...good, inspectionDate: "2026-12-01" },
      { isCorrection: false, today: "2026-09-19" },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.inspectionDate, /future/i);
  });

  test("the next due date must be after the inspection", () => {
    const result = checkRelease(
      { ...good, nextDueDate: "2026-09-18" },
      { isCorrection: false, today: "2026-09-19" },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.nextDueDate, /after/i);
  });

  test("the renewal rule is not applied here", () => {
    /*
      `compliance/renewal.ts` holds a confirmed rule. This phase records the
      date a person read off the PDF instead, so the two cannot disagree by
      one being derived and the other typed.
    */
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/documents/release.ts"),
      "utf8",
    );
    assert.equal(/nextDueDate|RENEWAL_INTERVAL/.test(source.split("export function checkRelease")[0]) && source.includes("requireNextDueDate"), false);
    assert.equal(source.includes("requireNextDueDate"), false);
    assert.equal(source.includes("nextDueDate(inspectionDate)"), false);
  });

  test("a correction has to say what is being corrected", () => {
    const result = checkRelease(good, { isCorrection: true, today: "2026-09-19" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.correctionReason);

    const withReason = checkRelease(
      { ...good, correctionReason: "Wrong appliance model." },
      { isCorrection: true, today: "2026-09-19" },
    );
    assert.equal(withReason.ok, true);
  });

  test("whether it is a correction is not taken from the form", () => {
    // The caller passes it, from the database. A form field could be omitted.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/documents/release.ts"),
      "utf8",
    );
    assert.match(source, /options: \{ isCorrection: boolean/);
    assert.equal(/input\.isCorrection/.test(source), false);
  });
});

describe("who may be emailed", () => {
  test("the agency and the customer, and nobody else", () => {
    assert.deepEqual([...CERTIFICATE_RECIPIENTS], ["agent", "customer"]);
  });

  test("the tenant is not a recipient", () => {
    /*
      A tenant reaches this system through a scheduling link, which is a
      token for choosing an appointment and has never been an identity.
      Whether they are entitled to a compliance document is a decision
      nobody has made.
    */
    assert.equal(isCertificateRecipient("tenant"), false);
    assert.equal(isCertificateRecipient("bscj"), false);
    assert.equal(isCertificateRecipient("someone@example.com"), false);
  });

  test("a queue row is keyed on the version and the recipient", () => {
    // A correction is a new certificate id, so it is a new intent; the same
    // version to the same recipient is the same key and cannot double-send.
    const rows = certificateRows({
      jobId: "j",
      certificateId: "c1",
      recipients: [
        { recipient: "agent", address: "agency@example.com" },
        { recipient: "customer", address: "landlord@example.com" },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].idempotencyKey, certificateKey("c1", "agent"));
    assert.notEqual(rows[0].idempotencyKey, rows[1].idempotencyKey);
    assert.notEqual(certificateKey("c1", "agent"), certificateKey("c2", "agent"));
  });

  test("the approved address is frozen onto the row", () => {
    /*
      The queue used to carry a role and the worker resolved it when it
      sent. For a certificate that is wrong: an administrator read the
      document and chose an address they could see, and an edit in between
      would redirect an approved document to somewhere nobody approved.

      The address is in the row, and the key still carries no address —
      it is the *value* that is frozen, not the identifier.
    */
    const rows = certificateRows({
      jobId: "j",
      certificateId: "c1",
      recipients: [{ recipient: "agent", address: "agency@example.com" }],
    });
    assert.equal(rows[0].recipientAddress, "agency@example.com");
    assert.equal(rows[0].recipient, "agent");
    assert.equal(rows[0].idempotencyKey.includes("@"), false);
  });

  test("the certificate can be read back out of its key", () => {
    assert.equal(certificateFromKey(certificateKey("c1", "agent")), "c1");
    assert.equal(certificateFromKey("appointment:j:2026-01-01T00:00:00.000Z"), null);
  });
});

/**
 * Structural guards.
 *
 * These are about a *later* edit. Each one names a property that is easy to
 * lose and expensive to lose quietly.
 */
describe("documents stay private", () => {
  const CERTS = readFileSync(
    path.resolve(process.cwd(), "src/lib/documents/certificates.ts"),
    "utf8",
  );
  const ROUTE = readFileSync(
    path.resolve(process.cwd(), "src/app/api/documents/[id]/route.ts"),
    "utf8",
  );
  const STORAGE = readFileSync(
    path.resolve(process.cwd(), "src/lib/storage/documents.ts"),
    "utf8",
  );

  test("every module is server-only", () => {
    for (const source of [CERTS, STORAGE]) {
      assert.match(source, /import "server-only"/);
    }
  });

  test("an agency sees a document only once it is released", () => {
    const check = CERTS.slice(
      CERTS.indexOf('case "organisation":'),
      CERTS.indexOf("if (!permitted)"),
    );
    assert.match(check, /released &&/);
    assert.match(check, /scope\.organisationId/);
  });

  test("an engineer sees only the job they are on", () => {
    const check = CERTS.slice(
      CERTS.indexOf('case "assigned":'),
      CERTS.indexOf('case "organisation":'),
    );
    assert.match(check, /row\.assignedEngineerId === scope\.userId/);
  });

  test("the agency listing filters on the organisation in its own WHERE", () => {
    const listing = CERTS.slice(CERTS.indexOf("export async function listAgencyJobCertificates"));
    assert.match(listing, /eq\(jobs\.agentOrganisationId, organisationId\)/);
    assert.match(listing, /eq\(certificates\.agentOrganisationId, organisationId\)/);
  });

  test("every refusal is the same answer", () => {
    // Distinguishing "not yours" from "not there" turns an id into a probe.
    assert.match(CERTS, /status: 404, error: "Not found\."/);
    assert.match(ROUTE, /error: "not_found"/);
  });

  test("the download route decides permission from the row, not the surface", () => {
    assert.match(ROUTE, /readDocumentFor\(session\.scope, id\)/);
    assert.match(ROUTE, /currentSession\(\)/);
  });

  test("a document response is never shared-cached and never sniffed", () => {
    assert.match(ROUTE, /"Cache-Control": "private, no-store, max-age=0"/);
    assert.match(ROUTE, /"X-Content-Type-Options": "nosniff"/);
  });

  test("a blob key never reaches a response", () => {
    /*
      It is an opaque key and it stays on the server. Checked against the
      code rather than the prose — the comment above the route says the
      words on purpose.
    */
    const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.equal(code.includes("blobKey"), false);
    assert.equal(code.includes("blob_key"), false);
  });

  test("a storage key carries nothing about the job", () => {
    const mint = STORAGE.slice(
      STORAGE.indexOf("export function newDocumentKey"),
      STORAGE.indexOf("const KEY_SHAPE"),
    );
    assert.match(mint, /randomBytes/);
    for (const term of ["reference", "jobId", "postcode", "filename"]) {
      assert.equal(mint.includes(term), false, `the key encodes ${term}`);
    }
  });

  test("a key from anywhere else cannot become a path", () => {
    assert.match(STORAGE, /const KEY_SHAPE = \/\^doc_\[0-9a-f\]\{48\}\$\//);
    assert.match(STORAGE, /if \(!KEY_SHAPE\.test\(key\)\)/);
  });

  test("the local driver refuses to run in production", () => {
    assert.match(STORAGE, /NODE_ENV === "production"/);
  });
});

describe("nothing is recorded that was not stored", () => {
  const CERTS = readFileSync(
    path.resolve(process.cwd(), "src/lib/documents/certificates.ts"),
    "utf8",
  );

  test("the bytes are stored before the row is written", () => {
    const upload = CERTS.slice(
      CERTS.indexOf("export async function uploadCertificate"),
      CERTS.indexOf("// Release"),
    );
    assert.ok(
      upload.indexOf("await putDocument") < upload.indexOf(".insert(documents)"),
      "a row can be written for a document that was never stored",
    );
  });

  test("a failed insert reports failure rather than success", () => {
    const upload = CERTS.slice(
      CERTS.indexOf("export async function uploadCertificate"),
      CERTS.indexOf("// Release"),
    );
    assert.match(upload, /error:\s*\n?\s*"The certificate could not be recorded/);
  });

  test("an issued certificate is superseded, never overwritten", () => {
    const release = CERTS.slice(CERTS.indexOf("export async function releaseCertificate"));
    assert.match(release, /status: "superseded"/);
    assert.match(release, /supersedesId: current\?\.id \?\? null/);
    assert.match(release, /version: nextVersion/);
    // And the supersede and the insert land together.
    assert.match(release, /db\.batch\(/);
    // Nothing updates an existing certificate's own fields.
    assert.equal(
      /\.update\(certificates\)[\s\S]{0,200}certificateNumber:/.test(release),
      false,
      "a release edits an issued certificate in place",
    );
  });

  test("releasing the same document twice is refused", () => {
    assert.match(CERTS, /That document has already been released\./);
  });

  test("only an unfiltered scope may release or send", () => {
    for (const fn of ["releaseCertificate", "queueCertificateEmail"]) {
      const body = CERTS.slice(CERTS.indexOf(`export async function ${fn}`));
      assert.match(
        body.slice(0, 800),
        /session\.scope\.kind !== "all"/,
        `${fn} can be called by an agency`,
      );
    }
  });

  test("a missing address is refused before anything is queued", () => {
    const send = CERTS.slice(CERTS.indexOf("export async function queueCertificateEmail"));
    assert.ok(
      send.indexOf("Nothing was queued.") < send.indexOf("certificateRows("),
      "rows are queued that can only ever fail",
    );
  });
});

/**
 * The email carries the document, to the address somebody approved.
 *
 * Structural: the behaviour lives in the worker and needs a database, but
 * the properties below are the ones that would be quiet and expensive to
 * lose — an attachment dropped, an approved address re-resolved, an
 * acceptance recorded before the provider gave one.
 */
describe("certificate emails", () => {
  const OUTBOX = readFileSync(
    path.resolve(process.cwd(), "src/lib/notifications/outbox.ts"),
    "utf8",
  );
  const SEND = readFileSync(
    path.resolve(process.cwd(), "src/lib/email/send.ts"),
    "utf8",
  );
  const deliver = OUTBOX.slice(
    OUTBOX.indexOf("async function deliverCertificate("),
    OUTBOX.indexOf("async function recipientStillEligible("),
  );

  test("the released PDF is attached", () => {
    // A recipient with no portal account has no other way to get it.
    assert.match(deliver, /attachments: \[/);
    assert.match(deliver, /content: stored\.bytes/);
    assert.match(SEND, /attachments\?: EmailAttachment\[\]/);
    assert.match(SEND, /toString\("base64"\)/);
  });

  test("the frozen address is used before any re-resolution", () => {
    const line = deliver.slice(deliver.indexOf("const to ="), deliver.indexOf("if (!to)"));
    assert.match(line, /row\.recipientAddress \?\?/);
  });

  test("eligibility is re-checked, and a revocation is failed for review", () => {
    assert.match(deliver, /recipientStillEligible\(/);
    assert.match(deliver, /state: "failed"/);
    assert.match(deliver, /lastError: eligible\.reason/);
    for (const reason of [
      "agency_no_longer_on_job",
      "agency_deactivated",
      "customer_deactivated",
      "approved_address_changed",
    ]) {
      assert.ok(OUTBOX.includes(reason), `${reason} is not a named outcome`);
    }
  });

  test("a storage failure retries rather than sending a bare message", () => {
    const block = deliver.slice(deliver.indexOf("const stored = await getDocument"));
    assert.match(block.slice(0, 300), /await refund\(db, row\);[\s\S]*?return "stillQueued";/);
  });

  test("an oversized attachment is not retried forever", () => {
    assert.match(deliver, /MAX_ATTACHMENT_BYTES/);
    assert.match(deliver, /"attachment_too_large"/);
  });

  test("a superseded version is stood down rather than sent", () => {
    assert.match(deliver, /"superseded_by_correction"/);
  });

  test("the provider key is the intent's own key, not a rebuilt one", () => {
    /*
      It must not vary between *attempts* — a retry after a timeout would
      be a second email — and it must vary between *approvals*, or a
      corrected address is deduplicated away by the provider. Deriving it
      from the row's key gets both, and rebuilding it from the certificate
      and recipient alone got the second one wrong.
    */
    assert.match(deliver, /approvalFromKey\(row\.idempotencyKey\)/);
    assert.equal(/idempotencySuffix:.*attempts/.test(deliver), false);
  });

  test("nothing is recorded as sent before the provider accepts", () => {
    const record = deliver.slice(deliver.indexOf("if (result.status === \"sent\")"));
    assert.ok(record.includes("sentAt: new Date()"));
    assert.ok(
      deliver.indexOf('if (result.status === "sent")') >
        deliver.indexOf("const result = await sendOutboxEmail"),
      "the send record is written before the provider answers",
    );
  });

  test("no billing information is in the message", () => {
    /*
      Checked against the code rather than the prose — the comment at the
      top of the renderer says why there is no price, using the words.
    */
    const RENDER = readFileSync(
      path.resolve(process.cwd(), "src/lib/email/certificate-release.ts"),
      "utf8",
    );
    const code = RENDER.replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    for (const term of ["price", "Price", "invoice", "Invoice", "£", "pence", "amount"]) {
      assert.equal(code.includes(term), false, `the email mentions ${term}`);
    }
  });
});

describe("the storage configuration is legible", () => {
  const STORAGE = readFileSync(
    path.resolve(process.cwd(), "src/lib/storage/documents.ts"),
    "utf8",
  );

  test("implemented-but-uncredentialled is distinguished from absent", () => {
    // One is a setting; the other would be a release. Reporting them the
    // same way is how somebody spends an afternoon on a bug that is neither.
    assert.match(STORAGE, /adapter is implemented but has no credentials/);
    assert.match(STORAGE, /No document store is configured/);
    assert.match(STORAGE, /export function isDriverImplemented/);
  });

  test("the activation requirement names the one variable", () => {
    assert.match(STORAGE, /BLOB_READ_WRITE_TOKEN/);
  });

  test("deleting is bounded to one minted key", () => {
    const fn = STORAGE.slice(
      STORAGE.indexOf("export async function deleteDocument"),
      STORAGE.indexOf("export type GetResult"),
    );
    assert.match(fn, /if \(!KEY_SHAPE\.test\(key\)\)/);
    assert.equal(fn.includes("list("), false);
    assert.equal(fn.includes("rmdir"), false);
    assert.equal(fn.includes("rm("), false);
  });

  test("a failed upload cleans up, and says so when it cannot", () => {
    const CERTS = readFileSync(
      path.resolve(process.cwd(), "src/lib/documents/certificates.ts"),
      "utf8",
    );
    const upload = CERTS.slice(
      CERTS.indexOf("export async function uploadCertificate"),
      CERTS.indexOf("// Release"),
    );
    assert.match(upload, /await deleteDocument\(stored\.key\)/);
    assert.match(upload, /kind: "document\.orphaned"/);
    // And only the key from this request is ever passed.
    assert.equal(/deleteDocument\((?!stored\.key)/.test(upload), false);
  });
});

/**
 * A re-approval is a new intent, not a retry.
 *
 * The defect this covers: the requeue used to reuse the row and its key
 * while swapping the address. The key is also the provider's idempotency
 * key, so Resend would have recognised the "new" message as the one it had
 * already accepted and sent nothing — the corrected address would never
 * have heard, and the failure would have looked like a success.
 */
describe("changing the approved address", () => {
  const CERTS = readFileSync(
    path.resolve(process.cwd(), "src/lib/documents/certificates.ts"),
    "utf8",
  );

  test("a different approval produces a different key", () => {
    const first = certificateKey("c1", "agent", 1);
    const second = certificateKey("c1", "agent", 2);
    assert.notEqual(first, second);
    // And the certificate is still readable out of both.
    assert.equal(certificateFromKey(first), "c1");
    assert.equal(certificateFromKey(second), "c1");
    assert.equal(approvalFromKey(first), 1);
    assert.equal(approvalFromKey(second), 2);
  });

  test("a retry of the same intent keeps the same key and payload", () => {
    /*
      The other half of the rule. The worker's own attempts never change
      the row, so a retry after an ambiguous outcome is recognised by the
      provider rather than sent twice.
    */
    assert.equal(certificateKey("c1", "agent", 1), certificateKey("c1", "agent", 1));
    const rows = certificateRows({
      jobId: "j",
      certificateId: "c1",
      recipients: [{ recipient: "agent", address: "a@example.com" }],
    });
    assert.equal(rows[0].idempotencyKey, certificateKey("c1", "agent", 1));
  });

  test("the requeue inserts a new row rather than rewriting the old one", () => {
    const fn = CERTS.slice(CERTS.indexOf("export async function requeueCertificateEmail"));
    const body = fn.slice(0, fn.indexOf("\n// ---"));
    assert.match(body, /\.insert\(outboundEmails\)/);
    assert.equal(
      /\.update\(outboundEmails\)/.test(body),
      false,
      "it still rewrites the earlier attempt, losing the history",
    );
    assert.match(body, /nextApproval/);
  });

  test("it refuses while one is still in flight, or already accepted", () => {
    const fn = CERTS.slice(CERTS.indexOf("export async function requeueCertificateEmail"));
    assert.match(fn, /already has a send waiting/);
    assert.match(fn, /already been accepted by the provider/);
  });
});

/**
 * An error is not proof the write did not happen.
 *
 * The defect this covers: the upload path deleted the stored object
 * whenever the insert threw. A timeout or a dropped connection can leave a
 * row committed while the client sees an error — and deleting then would
 * destroy the bytes a committed record points at.
 */
describe("a failed upload does not assume the write failed", () => {
  const CERTS = readFileSync(
    path.resolve(process.cwd(), "src/lib/documents/certificates.ts"),
    "utf8",
  );
  const upload = CERTS.slice(
    CERTS.indexOf("export async function uploadCertificate"),
    CERTS.indexOf("// Release"),
  );

  test("it looks for the row before deciding", () => {
    assert.match(upload, /eq\(documents\.blobKey, stored\.key\)/);
    assert.match(upload, /"committed" \| "absent" \| "unknown"/);
  });

  test("the object is deleted only when non-commit is established", () => {
    const deletion = upload.slice(upload.indexOf('if (settled === "absent")'));
    assert.match(deletion.slice(0, 200), /await deleteDocument\(stored\.key\)/);
    // And there is no other delete anywhere in the upload path.
    assert.equal(
      (upload.match(/deleteDocument\(/g) ?? []).length,
      1,
      "something else deletes without establishing the outcome",
    );
  });

  test("an unknown outcome keeps the object and records the uncertainty", () => {
    const unknown = upload.slice(upload.indexOf('if (settled === "unknown")'));
    assert.equal(
      unknown.slice(0, 400).includes("deleteDocument"),
      false,
      "it deletes on an outcome nobody established",
    );
    assert.match(unknown, /kind: "document\.upload_uncertain"/);
    assert.match(unknown, /KEPT, not deleted/);
    // And the engineer is told to check rather than to upload again blindly.
    assert.match(unknown, /Reload the job before uploading again/);
  });

  test("a write that did commit is reported as the success it was", () => {
    assert.match(upload, /if \(existing\) documentId = existing\.id;/);
    assert.match(upload, /Committed after all/);
  });
});
