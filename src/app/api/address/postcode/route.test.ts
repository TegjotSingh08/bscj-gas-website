import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * What the postcode endpoint is allowed to tell the browser.
 *
 * The response is deliberately minimal. Coverage is decided on the server from
 * coordinates the provider returned, measured against an operating centre held
 * in server-side configuration — so neither the coordinates nor the measured
 * distance belong in a public response. Publishing distances would let anyone
 * triangulate the centre from a handful of postcodes.
 *
 * The live postcode service is never contacted: it is free public
 * infrastructure and this suite runs hundreds of times.
 */

let providerBehaviour:
  | "in_area"
  | "out_of_area"
  | "not_found"
  | "malformed"
  | "unavailable" = "in_area";

mock.module("@/lib/address/postcodes-io", {
  namedExports: {
    PostcodesIoProvider: class {
      async lookup() {
        if (providerBehaviour === "not_found") return { status: "not_found" };
        if (providerBehaviour === "malformed") return { status: "malformed" };
        if (providerBehaviour === "unavailable") {
          return { status: "provider_unavailable" };
        }
        return {
          status: "valid",
          postcode: {
            postcode: "WV99 1AA",
            outcode: "WV99",
            areaName: "Wolverhampton",
            // About a mile from the centre, or London when out of area.
            latitude: providerBehaviour === "out_of_area" ? 51.5072 : 52.6,
            longitude: providerBehaviour === "out_of_area" ? -0.1276 : -2.12,
          },
        };
      }
    },
  },
});

mock.module("@/lib/booking/rate-limit", {
  namedExports: {
    rateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }),
    pruneRateLimits: () => {},
    clientKey: () => "test-client",
    rateLimits: { postcode: { limit: 30, windowSeconds: 600 } },
  },
});

const { POST } = await import("./route");

function lookup(postcode = "WV99 1AA") {
  return POST(
    new Request("http://localhost/api/address/postcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcode }),
    }),
  );
}

beforeEach(() => {
  providerBehaviour = "in_area";
});

describe("the postcode response carries only what the form renders", () => {
  test("a covered postcode returns the canonical postcode, town and coverage", async () => {
    const body = await (await lookup()).json();

    assert.deepEqual(body, {
      status: "valid",
      postcode: "WV99 1AA",
      areaName: "Wolverhampton",
      covered: true,
    });
  });

  test("no coordinates reach the browser", async () => {
    const raw = await (await lookup()).text();

    assert.equal(raw.includes("latitude"), false);
    assert.equal(raw.includes("longitude"), false);
    assert.equal(raw.includes("52.6"), false);
    assert.equal(raw.includes("-2.12"), false);
  });

  test("no distance from the operating centre reaches the browser", async () => {
    // A distance is enough to triangulate the centre, so it is never returned.
    const raw = await (await lookup()).text();
    assert.equal(raw.includes("distance"), false);
    assert.equal(raw.includes("Miles"), false);
  });

  test("the outcode is not returned, because nothing displays it", async () => {
    const body = await (await lookup()).json();
    assert.equal("outcode" in body, false);
  });

  test("the response is flat, not a nested provider object", async () => {
    const body = await (await lookup()).json();
    assert.equal(typeof body.postcode, "string");
  });

  test("the fields the form actually needs are all present", async () => {
    const body = await (await lookup()).json();

    // The form renders the canonical postcode and town, gates the address
    // fields on `covered`, and reads nothing else.
    assert.deepEqual(Object.keys(body).sort(), [
      "areaName",
      "covered",
      "postcode",
      "status",
    ]);
  });
});

describe("coverage is decided on the server", () => {
  test("a valid postcode outside the radius is reported as not covered", async () => {
    providerBehaviour = "out_of_area";
    const body = await (await lookup()).json();

    assert.equal(body.status, "valid");
    assert.equal(body.covered, false);
  });

  test("outside the area is still a valid postcode, never called invalid", async () => {
    providerBehaviour = "out_of_area";
    const body = await (await lookup()).json();
    assert.notEqual(body.status, "not_found");
  });

  test("an unknown postcode is reported as not found", async () => {
    providerBehaviour = "not_found";
    const body = await (await lookup()).json();
    assert.deepEqual(body, { status: "not_found" });
  });

  test("a provider outage is distinguished from an invalid postcode", async () => {
    providerBehaviour = "unavailable";
    const response = await lookup();

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "provider_unavailable" });
  });

  test("nonsense is rejected before anything is returned about it", async () => {
    providerBehaviour = "malformed";
    const body = await (await lookup()).json();
    assert.deepEqual(body, { status: "malformed" });
  });
});
