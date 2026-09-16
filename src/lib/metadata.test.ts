import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { business } from "./business";
import { pageOpenGraph } from "./metadata";

/**
 * Canonical origin and Open Graph rules.
 *
 * The production site is https://www.bscj-solutions.com, with the apex 308ing
 * to it at the edge. Everything public must agree on that one origin, or the
 * apex, the www host and the Vercel URL start competing for the same content.
 */

const APP_ROOT = path.resolve(process.cwd(), "src/app");

/** Every page file that declares route metadata. */
function pageFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...pageFiles(full));
    else if (entry.name === "page.tsx") found.push(full);
  }
  return found;
}

const allPages = pageFiles(APP_ROOT);

/**
 * The internal admin surface, which plays by the opposite rules: it must not
 * be indexed, must not advertise a canonical, and has no share preview to get
 * right. It is held to its own assertions further down rather than exempted.
 */
const ADMIN_ROOT = path.join(APP_ROOT, "admin");
const adminPages = allPages.filter((file) => file.startsWith(ADMIN_ROOT));

/** Everything a customer or a crawler can reach. */
const pages = allPages.filter((file) => !file.startsWith(ADMIN_ROOT));

describe("there is one production origin", () => {
  test("it is the www host, over https", () => {
    assert.equal(business.url, "https://www.bscj-solutions.com");
    assert.equal(business.domain, "www.bscj-solutions.com");
  });

  test("nothing public references the Vercel deployment URL", () => {
    // The apex 308s to www at the edge; the *.vercel.app host does not, so a
    // canonical pointing at it would split the site in two for a crawler.
    const sources = [...allPages, path.resolve(process.cwd(), "src/lib/business.ts")];
    for (const file of sources) {
      const contents = readFileSync(file, "utf8");
      assert.equal(
        /vercel\.app/.test(contents),
        false,
        `${path.relative(process.cwd(), file)} references a vercel.app URL`,
      );
    }
  });

  test("no page hardcodes an absolute site origin", () => {
    // Canonicals and og:urls are relative and resolve against metadataBase,
    // so the origin is defined once and cannot drift per page.
    for (const file of pages) {
      const contents = readFileSync(file, "utf8");
      assert.equal(
        /(canonical|url):\s*["'`]https?:\/\//.test(contents),
        false,
        `${path.relative(process.cwd(), file)} hardcodes an origin`,
      );
    }
  });

  test("no page points at localhost", () => {
    for (const file of pages) {
      assert.equal(/localhost/.test(readFileSync(file, "utf8")), false);
    }
  });
});

describe("every page declares its own canonical and Open Graph URL", () => {
  test("each page sets a canonical", () => {
    for (const file of pages) {
      const contents = readFileSync(file, "utf8");
      if (!contents.includes("export const metadata")) continue;
      assert.match(
        contents,
        /alternates:\s*\{\s*canonical:/,
        `${path.relative(process.cwd(), file)} has no canonical`,
      );
    }
  });

  test("a page's og:url matches its canonical", () => {
    // These drifting apart is how /book ends up telling Facebook it is the
    // homepage, which is exactly what this audit found.
    for (const file of pages) {
      const contents = readFileSync(file, "utf8");
      const canonical = contents.match(/canonical:\s*"([^"]+)"/)?.[1];
      const og = contents.match(/pageOpenGraph\("([^"]+)"\)/)?.[1];
      if (!canonical || canonical === "/") continue;

      assert.equal(
        og,
        canonical,
        `${path.relative(process.cwd(), file)}: og:url ${og} ≠ canonical ${canonical}`,
      );
    }
  });
});

describe("the Open Graph helper returns a complete block", () => {
  const og = pageOpenGraph("/book") as Record<string, unknown>;

  test("it carries the fields a page would otherwise lose", () => {
    // Next merges metadata shallowly: declaring `openGraph` at all replaces
    // the layout's block, so a bare { url } silently drops these four.
    assert.equal(og.type, "website");
    assert.equal(og.locale, "en_GB");
    assert.equal(og.siteName, business.name);
    assert.ok(Array.isArray(og.images) && og.images.length === 1);
  });

  test("the share image is described, not just linked", () => {
    const [image] = og.images as Record<string, unknown>[];
    assert.equal(image.url, "/opengraph-image");
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
    assert.ok(String(image.alt).includes(business.name));
  });

  test("the url stays relative, so one origin governs it", () => {
    assert.equal(og.url, "/book");
  });
});

describe("robots and the sitemap use the canonical origin", () => {
  const robots = readFileSync(path.resolve(process.cwd(), "src/app/robots.ts"), "utf8");
  const sitemap = readFileSync(path.resolve(process.cwd(), "src/app/sitemap.ts"), "utf8");

  test("both build their URLs from business.url", () => {
    assert.match(robots, /business\.url/);
    assert.match(sitemap, /business\.url/);
  });

  test("robots points crawlers at the sitemap on that origin", () => {
    assert.match(robots, /sitemap:\s*`\$\{business\.url\}\/sitemap\.xml`/);
    assert.match(robots, /host:\s*business\.url/);
  });

  test("neither hardcodes a host", () => {
    for (const contents of [robots, sitemap]) {
      assert.equal(/https?:\/\//.test(contents), false);
    }
  });
});


/**
 * The admin area is the one part of the site that must be invisible.
 *
 * A canonical on an internal page invites a crawler to index it; a share
 * preview on a staff login is a link that can be posted. Both are held to the
 * opposite of the public rules above, so an admin page added later cannot
 * quietly acquire either.
 */
describe("the admin area is not part of the public site", () => {
  test("there is an admin surface to check", () => {
    assert.ok(adminPages.length > 0, "no admin pages were found");
  });

  test("every admin page refuses indexing", () => {
    for (const file of adminPages) {
      const contents = readFileSync(file, "utf8");
      assert.match(
        contents,
        /robots:\s*\{[^}]*index:\s*false/,
        `${path.relative(process.cwd(), file)} does not refuse indexing`,
      );
    }
  });

  test("no admin page declares a canonical or a share preview", () => {
    for (const file of adminPages) {
      const contents = readFileSync(file, "utf8");
      const name = path.relative(process.cwd(), file);
      assert.equal(
        /alternates:\s*\{\s*canonical:/.test(contents),
        false,
        `${name} declares a canonical`,
      );
      assert.equal(
        contents.includes("pageOpenGraph"),
        false,
        `${name} declares a share preview`,
      );
    }
  });

  test("the admin layout refuses indexing for anything beneath it", () => {
    // A page added without its own metadata still inherits this.
    const layout = readFileSync(
      path.join(ADMIN_ROOT, "layout.tsx"),
      "utf8",
    );
    assert.match(layout, /robots:\s*\{[^}]*index:\s*false/);
  });

  test("the sitemap lists no admin route", () => {
    const sitemap = readFileSync(
      path.resolve(process.cwd(), "src/app/sitemap.ts"),
      "utf8",
    );
    assert.equal(sitemap.includes("/admin"), false);
  });
});
