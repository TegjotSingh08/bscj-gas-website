import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { agencyPagePublished } from "../../src/lib/config/publication";

/**
 * The agency page is off unless BSCJ turns it on.
 *
 * An earlier note called it "unpublished" because it carried `noindex` and was
 * absent from the sitemap. Neither is an access control: a route that exists is
 * reachable by anyone who types it the moment it is deployed. The gate is what
 * makes the claim true.
 */

describe("publication is a decision the owner makes", () => {
  test("absent by default", () => {
    assert.equal(agencyPagePublished({} as unknown as NodeJS.ProcessEnv), false);
  });

  test("on only for the exact opt-in value", () => {
    assert.equal(
      agencyPagePublished({ BSCJ_AGENCY_PAGE: "1" } as unknown as NodeJS.ProcessEnv),
      true,
    );
  });

  test("anything else is off — no accidental truthiness", () => {
    // "false", "0" and "no" are all things somebody might type meaning off.
    for (const value of ["", "0", "false", "no", "true", "yes", "on"]) {
      assert.equal(
        agencyPagePublished({ BSCJ_AGENCY_PAGE: value } as unknown as NodeJS.ProcessEnv),
        false,
        `"${value}" must not publish the page`,
      );
    }
  });

  test("the page itself refuses to render without it", async () => {
    /*
      Asserted structurally because the page is a JSX module: what matters is
      that it calls the gate and answers `notFound()`, not how it is styled.
    */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "src/app/(site)/letting-agents/page.tsx",
      "utf8",
    );
    assert.match(source, /if \(!agencyPagePublished\(\)\) notFound\(\)/);
  });
});
