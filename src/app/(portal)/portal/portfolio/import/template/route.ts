import { requireAgentOrThrow } from "@/lib/auth/session";
import { TEMPLATE_FILENAME, templateCsv } from "@/lib/portfolio/import/columns";

export const dynamic = "force-dynamic";

/**
 * The template, as a download.
 *
 * Behind `requireAgentOrThrow()` even though it contains nothing secret — it
 * is generated from a column list and a fictional example row. Two reasons:
 * it sits under `/portal`, where the rule is that everything is authenticated
 * and a single exception is how the rule stops being readable; and a template
 * that drifts from the parser should be discoverable only by the people who
 * will actually use it.
 *
 * `Content-Disposition: attachment` with an explicit filename, and
 * `text/csv; charset=utf-8` so a spreadsheet opens it as text rather than
 * guessing an encoding.
 */
export async function GET(): Promise<Response> {
  await requireAgentOrThrow();

  return new Response(templateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILENAME}"`,
      // Generated per request from code. Nothing to cache and nothing a proxy
      // should hold on behalf of one agency.
      "Cache-Control": "no-store",
    },
  });
}
