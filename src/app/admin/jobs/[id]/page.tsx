import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/session";
import { getJob, jobTimeline, listEngineers } from "@/lib/jobs/queries";
import { productFor } from "@/lib/booking/products";
import { bookingConfig } from "@/lib/booking/config";
import {
  fetchNotificationStates,
  fetchRecordedException,
} from "@/lib/notifications/outbox";
import { LateBookingNotice } from "@/components/jobs/LateBookingNotice";
import { JobMessages } from "@/components/jobs/JobMessages";
import { JobTimeline } from "@/components/jobs/JobTimeline";
import {
  ClientPill,
  DeadlineNote,
  StatusPill,
} from "@/components/jobs/JobLabels";
import {
  ATTENTION_LABELS,
  ATTENTION_NOTES,
} from "@/lib/jobs/attention";
import { assignRefusal, canAssign, canUnassign } from "@/lib/jobs/work";
import type { JobLifecycleStatus } from "@/lib/jobs/lifecycle";
import { ResendInvitation } from "../ResendInvitation";
import { AssignEngineer } from "../AssignEngineer";
import {
  ReleaseCertificate,
  SendCertificate,
  UpdateRenewal,
} from "../CertificateReview";
import {
  certificateRecipientAddresses,
  listJobCertificates,
  listPendingDocuments,
} from "@/lib/documents/certificates";
import { renewalIsOutstanding } from "@/lib/compliance/outstanding";
import { storageStatus } from "@/lib/storage/documents";
import { listJobInvoices } from "@/lib/invoices/invoices";
import { formatPence } from "@/lib/invoices/model";
import { RaiseInvoice } from "../RaiseInvoice";
import { InvoiceStatusPill } from "../../invoices/StatusPill";
import { AdminNav } from "../../AdminNav";

export const metadata: Metadata = {
  title: "Job",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-navy-100 py-2 last:border-0 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-navy-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-navy-900 sm:col-span-2 sm:mt-0">
        {value ?? "—"}
      </dd>
    </div>
  );
}

/**
 * One job, in full.
 *
 * It was a read-only check that a website booking had been recorded. It is
 * now the screen somebody runs a job from, and the difference is one
 * mutation: **allocation**. Starting and completing the work belong to
 * whoever is actually standing at the property, so those controls live on the
 * engineer's own screen and are not duplicated here — an administrator who
 * needs them opens `/engineer`, which they are allowed to do, and acts as
 * themselves rather than on somebody's behalf.
 *
 * Everything the allocation controls decide is decided again in the action,
 * from the row. The buttons are rendered from the same pure rules the write
 * enforces, so what is offered and what is permitted cannot drift apart.
 */
export default async function AdminJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, scope } = await requireAdmin();
  const { id } = await params;

  // Out of scope and non-existent are the same answer, decided in the query.
  const found = await getJob(scope, id);
  if (!found) notFound();

  const {
    job,
    customer,
    property,
    tenancy,
    priceSnapshot,
    engineerName,
    organisationName,
    risk,
    attention,
  } = found;
  const product = productFor(job.productId);
  const status = job.lifecycleStatus as JobLifecycleStatus;

  const facts = {
    lifecycleStatus: status,
    assignedEngineerId: job.assignedEngineerId,
    hasAppointment: job.appointmentStart !== null,
  };

  const [
    engineers,
    timeline,
    notifications,
    pendingDocuments,
    allCertificates,
    recipients,
    invoices,
  ] = await Promise.all([
      listEngineers(scope),
      jobTimeline(scope, job.id),
      fetchNotificationStates(job.id),
      listPendingDocuments(job.id),
      listJobCertificates(job.id),
      certificateRecipientAddresses(job.id),
      listJobInvoices(job.id),
    ]);

  /*
    "Live" means not voided. A job with a voided invoice and nothing else may
    be invoiced again — which is the whole reason voiding exists — so the
    control is offered from the state of the invoices, not from whether any
    have ever been raised.
  */
  const liveInvoice = invoices.find((invoice) => invoice.status !== "void") ?? null;

  const currentCertificate =
    allCertificates.find((c) => c.status === "issued") ?? null;
  const storage = storageStatus();

  /*
    **Was this certificate released without its renewal moving?**

    Read from the records rather than remembered from the release's response.
    A response is transient — refresh the page, or come back tomorrow, and the
    only trace that something was left undone would be gone. An issued
    certificate with no active position pointing at it *is* the state.
  */
  const renewalState = currentCertificate
    ? await renewalIsOutstanding(currentCertificate.id)
    : "resolved";

  /*
    What the outbox says about each recipient, **per certificate version**.
    The key carries the certificate id, so a correction starts with a clean
    slate — which is right: somebody told about the old version should hear
    about the new one.
  */
  const sendStates = (certificateId: string) =>
    notifications
      .filter(
        (n) =>
          n.kind === "certificate-release" &&
          n.idempotencyKey.includes(certificateId),
      )
      .map((n) => ({
        recipient: n.recipient,
        approvedAddress: n.recipientAddress,
        state: n.state,
        attempts: n.attempts,
        lastError: n.lastError,
        sentAt: n.sentAt,
      }));

  const when = (value: Date | null) =>
    value
      ? value.toLocaleString("en-GB", {
          timeZone: bookingConfig.timeZone,
          dateStyle: "full",
          timeStyle: "short",
        })
      : null;

  /*
    Only read when the job actually carries an exception, so an ordinary job
    costs nothing extra. The flag is on the row; the detail is on the timeline.
  */
  const exception = job.deadlineExceptionAt
    ? await fetchRecordedException(job.id, job.appointmentStart)
    : null;

  return (
    <>
      <AdminNav userName={user.name} current="jobs" />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold text-navy-900">
              {job.reference}
            </h1>
            <StatusPill status={status} />
            <ClientPill organisationName={organisationName} />
          </div>
          <Link
            href="/admin/jobs"
            className="text-sm font-bold text-flame-600 underline"
          >
            Back to jobs
          </Link>
        </div>

        {attention.length > 0 && (
          <section
            role="alert"
            className="mt-4 rounded-2xl border-2 border-flame-500 bg-flame-400/10 p-5"
          >
            <h2 className="text-sm font-extrabold text-navy-900">
              This job needs somebody
            </h2>
            <ul className="mt-2 grid gap-2 text-sm text-navy-800">
              {attention.map((reason) => (
                <li key={reason}>
                  <strong className="font-extrabold text-navy-900">
                    {ATTENTION_LABELS[reason]}
                  </strong>{" "}
                  — {ATTENTION_NOTES[reason]}
                </li>
              ))}
            </ul>
          </section>
        )}

        {exception && (
          <LateBookingNotice
            exception={exception}
            notifications={notifications.filter(
              (n) => n.kind === "late-booking-exception",
            )}
            audience="admin"
          />
        )}

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Who is on it</h2>
          <dl className="mt-2">
            <Row
              label="Engineer"
              value={engineerName ?? "Nobody allocated yet"}
            />
            <Row label="Started" value={when(job.workStartedAt)} />
            <Row label="Finished" value={when(job.completedAt)} />
            {job.completionNotes && (
              <Row
                label="What the engineer recorded"
                value={
                  <span className="whitespace-pre-wrap">
                    {job.completionNotes}
                  </span>
                }
              />
            )}
          </dl>

          <AssignEngineer
            jobId={job.id}
            engineers={engineers}
            assignedEngineerId={job.assignedEngineerId}
            canAssign={canAssign(facts)}
            canUnassign={canUnassign(facts)}
            refusal={assignRefusal(facts)}
          />
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Appointment</h2>
          <dl className="mt-2">
            <Row label="Service" value={product.name} />
            <Row label="Starts" value={when(job.appointmentStart)} />
            <Row label="Ends" value={when(job.appointmentEnd)} />
            <Row
              label="Duration"
              value={job.durationMinutes ? `${job.durationMinutes} minutes` : null}
            />
            <Row label="Booked by" value={job.schedulingMethod.replace(/_/g, " ")} />
            <Row label="Source" value={job.source.replace(/_/g, " ")} />
            <Row
              label="Requested completion date"
              value={
                job.completeByDate ? (
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span>{job.completeByDate}</span>
                    <DeadlineNote risk={risk} completeByDate={job.completeByDate} />
                  </span>
                ) : job.requestedAsap ? (
                  "As soon as possible — no date given"
                ) : null
              }
            />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">
            Gas safety record
          </h2>

          {!storage.ready && (
            <p
              role="alert"
              className="mt-2 rounded-xl border-2 border-flame-500 bg-flame-400/10 px-4 py-3 text-sm font-semibold text-navy-900"
            >
              Document storage is not available. {storage.requirement}
            </p>
          )}

          {pendingDocuments.length === 0 && allCertificates.length === 0 ? (
            <p className="mt-2 text-sm text-navy-700">
              Nothing uploaded yet. The engineer uploads the PDF from their own
              screen once they are on site.
            </p>
          ) : null}

          {pendingDocuments.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-bold uppercase tracking-wide text-flame-600">
                {pendingDocuments.length} waiting for review
              </p>
              <p className="mt-1 text-sm text-navy-700">
                Uploaded and not released. The agency cannot see these, and
                nobody has been emailed.
              </p>
              <div className="mt-3 grid gap-3">
                {pendingDocuments.map((doc) => (
                  <ReleaseCertificate
                    key={doc.id}
                    jobId={job.id}
                    document={doc}
                    isCorrection={currentCertificate !== null}
                  />
                ))}
              </div>
            </div>
          )}

          {allCertificates.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
                Issued
              </p>
              <ul className="mt-2 grid gap-3">
                {allCertificates.map((cert) => (
                  <li
                    key={cert.id}
                    className={`rounded-xl border-2 px-4 py-3 ${
                      cert.status === "issued"
                        ? "border-trust-600 bg-trust-50"
                        : "border-navy-200 bg-white"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-extrabold text-navy-900">
                        {cert.certificateNumber}
                        {cert.version > 1 && ` · version ${cert.version}`}
                      </p>
                      <p className="text-xs font-bold uppercase tracking-wide text-navy-600">
                        {cert.status === "issued" ? "Current" : "Superseded"}
                      </p>
                    </div>
                    <dl className="mt-2">
                      <Row label="Inspection date" value={cert.inspectionDate} />
                      <Row label="Next due" value={cert.nextDueDate} />
                      <Row
                        label="Released"
                        value={`${when(cert.issuedAt)}${
                          cert.issuedByName ? ` by ${cert.issuedByName}` : ""
                        }`}
                      />
                      {cert.correctionReason && (
                        <Row label="Correction" value={cert.correctionReason} />
                      )}
                      {Array.isArray(cert.sentTo) && cert.sentTo.length > 0 && (
                        <Row
                          label="Sent to"
                          value={
                            <ul className="grid gap-0.5">
                              {(cert.sentTo as { address?: string; at?: string }[]).map(
                                (entry, index) => (
                                  <li key={index} className="break-all text-xs">
                                    {entry.address}
                                    {entry.at
                                      ? ` · ${new Date(entry.at).toLocaleString("en-GB", { timeZone: bookingConfig.timeZone, dateStyle: "medium", timeStyle: "short" })}`
                                      : ""}
                                  </li>
                                ),
                              )}
                            </ul>
                          }
                        />
                      )}
                      <Row
                        label="Document"
                        value={
                          cert.documentId ? (
                            <a
                              href={`/api/documents/${cert.documentId}`}
                              target="_blank"
                              rel="noopener"
                              className="font-bold text-flame-600 underline"
                            >
                              {cert.filename ?? "Open the PDF"}
                            </a>
                          ) : (
                            "No document"
                          )
                        }
                      />
                    </dl>

                    {cert.status === "issued" && (
                      <>
                        {renewalState === "outstanding" && (
                          <p
                            role="alert"
                            className="mt-3 rounded-lg border-2 border-flame-500 bg-flame-400/10 px-3 py-2 text-xs font-semibold text-navy-900"
                          >
                            This certificate is released, but the
                            property&rsquo;s next-due date has not moved. The
                            renewal write did not land. Press the button below —
                            it is safe, and it does nothing if the renewal
                            already matches.
                          </p>
                        )}
                        {/*
                          Unknown is said, not hidden. Reporting "nothing is
                          wrong" from a query that failed is the one answer that
                          would let a real failure sit unnoticed.
                        */}
                        {renewalState === "unavailable" && (
                          <p
                            role="status"
                            className="mt-3 rounded-lg border-2 border-navy-300 bg-navy-50 px-3 py-2 text-xs font-semibold text-navy-900"
                          >
                            We could not check whether this certificate&rsquo;s
                            renewal was recorded. That is not the same as it
                            being fine — reload, and if it persists the button
                            below is safe to press either way.
                          </p>
                        )}
                        <UpdateRenewal
                          jobId={job.id}
                          certificateId={cert.id}
                        />
                        <SendCertificate
                          jobId={job.id}
                          certificate={cert}
                          recipients={recipients}
                          states={sendStates(cert.id)}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Invoice</h2>

          {invoices.length === 0 && status !== "completed" && (
            <p className="mt-2 text-sm text-navy-700">
              An invoice is raised once the work is completed.
            </p>
          )}

          {invoices.length > 0 && (
            <ul className="mt-2 grid gap-2">
              {invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-navy-50 px-4 py-3"
                >
                  <span className="text-sm">
                    <Link
                      href={`/admin/invoices/${invoice.id}`}
                      className="font-bold text-navy-900 hover:underline"
                    >
                      {invoice.number ?? "Draft"}
                    </Link>
                    <span className="ml-3 text-navy-700">
                      {formatPence(invoice.totalPence)}
                    </span>
                  </span>
                  <InvoiceStatusPill status={invoice.status} />
                </li>
              ))}
            </ul>
          )}

          {status === "completed" && liveInvoice === null && (
            <RaiseInvoice jobId={job.id} />
          )}

          {liveInvoice !== null && (
            <p className="mt-2 text-xs text-navy-600">
              This job has a live invoice. Void it before raising another —
              which keeps its number and the reason it was withdrawn.
            </p>
          )}
        </section>

        <JobMessages notifications={notifications}>
          <ResendInvitation jobId={job.id} />
        </JobMessages>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Customer</h2>
          <dl className="mt-2">
            <Row label="Name" value={customer?.name} />
            <Row label="Company" value={customer?.company} />
            <Row label="Type" value={customer?.type.replace(/_/g, " ")} />
            <Row label="Email" value={customer?.email} />
            <Row
              label="Phone"
              value={
                customer?.phone ? (
                  <a className="underline" href={`tel:${customer.phone}`}>
                    {customer.phone}
                  </a>
                ) : null
              }
            />
            <Row label="Agency" value={organisationName ?? "None — private work"} />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Property</h2>
          <dl className="mt-2">
            <Row
              label="Address"
              value={
                property
                  ? [property.houseOrName, property.street, property.town]
                      .filter(Boolean)
                      .join(", ")
                  : null
              }
            />
            <Row label="Postcode" value={property?.postcode} />
            <Row label="Access notes" value={property?.accessNotes} />
            <Row
              label="Tenant"
              value={
                tenancy
                  ? [tenancy.name, tenancy.phone].filter(Boolean).join(" — ")
                  : "Not applicable"
              }
            />
          </dl>
        </section>

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Price</h2>
          <dl className="mt-2">
            <Row label="Total charged" value={money(job.priceTotalPence)} />
            <Row
              label="Appliances"
              value={
                job.applianceCount === null
                  ? "Not priced by appliance"
                  : String(job.applianceCount)
              }
            />
            {/*
              Read from the frozen snapshot, never re-resolved. What this job cost
              is what it cost, whatever the price list says today.
            */}
            <Row
              label="Rate applied"
              value={
                priceSnapshot
                  ? `${money(priceSnapshot.unitPricePence)} (${priceSnapshot.source})`
                  : "Snapshot unreadable"
              }
            />
            <Row
              label="List price then"
              value={priceSnapshot ? money(priceSnapshot.listPricePence) : null}
            />
            <Row
              label="Extra appliance charge"
              value={priceSnapshot ? money(priceSnapshot.extraChargePence) : null}
            />
          </dl>
        </section>

        <JobTimeline entries={timeline} timeZone={bookingConfig.timeZone} />

        <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
          <h2 className="text-sm font-extrabold text-navy-900">Record</h2>
          <dl className="mt-2">
            <Row label="Calendar event" value={job.calendarEventId} />
            <Row
              label="Calendar sync"
              value={job.calendarSyncState.replace(/_/g, " ")}
            />
            <Row label="Recorded" value={when(job.createdAt)} />
          </dl>
        </section>
      </main>
    </>
  );
}
