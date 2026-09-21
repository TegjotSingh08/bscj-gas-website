/**
 * Pages that exist in the codebase but are not published yet.
 *
 * **The distinction this exists to make honest.** A page was described as
 * "unpublished" because it carried `noindex` and was absent from the sitemap.
 * Neither is an access control: a route that exists is reachable by anyone who
 * types it the moment it is deployed, and `noindex` is a request to search
 * engines rather than a rule about who may read it.
 *
 * So publication is a switch, absent by default, and the route answers 404
 * without it — the same answer an unknown route gives, so the page's existence
 * is not disclosed either. Turning it on is an environment change on the
 * deployment: the owner decides when their page goes live, and deploying the
 * code does not decide it for them.
 *
 * Deliberately **not** a database setting. A public marketing page should not
 * take a query to render, and "is this launched" is a property of a deployment
 * rather than of the business's records.
 */

/**
 * Whether the letting-agent page is published on this deployment.
 *
 * Read per request, so turning it on is a variable and a restart rather than a
 * rebuild. Only the exact opt-in counts: `"false"`, `"0"` and `"no"` are all
 * things somebody might type meaning *off*, and a looser check would read every
 * one of them as on.
 */
export function agencyPagePublished(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BSCJ_AGENCY_PAGE === "1";
}
