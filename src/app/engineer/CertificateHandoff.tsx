import Link from "next/link";

/**
 * Getting the job's details into the certificate generator.
 *
 * Two steps, spelled out on the screen rather than kept in a document
 * somebody has to find. An engineer standing in a hallway should not have to
 * remember a workflow, and nothing here assumes a developer set anything up.
 *
 * The download is a plain link, not a fetch: the browser's own handling is
 * better than anything re-implemented here, it works with no JavaScript, and
 * the response is an attachment so nothing is rendered. The job id is in the
 * path and there is no query string — no name, address or postcode ever
 * reaches a URL.
 *
 * The generator is a second link, into `/engineer/certificate`, which serves
 * it from inside the authenticated area. It used to be a file path in a
 * sentence; an instruction that tells somebody to find `index.html` on disk
 * is an instruction that assumes a machine has been set up, and this one is
 * used in a van.
 */
export function CertificateHandoff({
  jobId,
  reference,
}: {
  jobId: string;
  reference: string;
}) {
  return (
    <section className="mt-4 rounded-2xl border-2 border-navy-200 bg-white p-5">
      <h2 className="text-sm font-extrabold uppercase tracking-wide text-navy-600">
        Gas safety record
      </h2>

      <ol className="mt-3 grid gap-4 text-sm text-navy-800">
        <li>
          <p className="font-bold text-navy-900">1. Download this job&rsquo;s details</p>
          <p className="mt-1">
            A small file with the property, the landlord and your own details
            in it. No readings, no results and no date — those are yours to
            enter.
          </p>
          <a
            href={`/api/engineer/jobs/${jobId}/cp12-prefill`}
            download
            className="mt-2 inline-block rounded-xl bg-flame-500 px-5 py-3 text-base font-extrabold text-navy-900 hover:bg-flame-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-900"
          >
            Download CP12 job details
          </a>
        </li>

        <li>
          <p className="font-bold text-navy-900">2. Open the generator</p>
          <p className="mt-1">
            It opens in a new tab, signed in as you. There is nothing to
            install and no file to find.
          </p>
          <a
            href="/engineer/certificate"
            target="_blank"
            rel="noopener"
            className="mt-2 inline-block rounded-xl border-2 border-navy-300 bg-white px-5 py-3 text-base font-extrabold text-navy-900 hover:border-flame-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-900"
          >
            Open the certificate generator
          </a>
        </li>

        <li>
          <p className="font-bold text-navy-900">3. Import the file</p>
          <p className="mt-1">
            In the generator, press <strong>Import job details</strong> and
            choose the file you saved in step 1. It fills the address and
            contact boxes, and leaves the readings, the safety outcomes, the
            date and the certificate number for you.
          </p>
        </li>
      </ol>

      <p className="mt-4 text-xs leading-relaxed text-navy-600">
        The downloaded file contains customer details. Delete it once the
        certificate is done. The generator keeps your work in this browser
        only — nothing is uploaded.{" "}
        <Link
          href="/engineer"
          className="font-bold text-flame-600 underline"
        >
          Back to today
        </Link>
      </p>

      <p className="sr-only">
        Reference {reference}. The download is authorised against this job and
        your account; it is not available from the reference alone.
      </p>
    </section>
  );
}
