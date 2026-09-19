import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Structural guards on the admin surface.
 *
 * These are repository-level assertions rather than request tests, for the
 * same reason `public-content.test.ts` is: the failure they exist to prevent
 * is a *new file* that quietly does the wrong thing. An admin page added later
 * without an authorisation check, or a public page that starts importing the
 * auth stack, would both pass every behavioural test in the suite.
 */

const ROOT = process.cwd();
const APP_ROOT = path.resolve(ROOT, "src/app");
const ADMIN_ROOT = path.join(APP_ROOT, "admin");
/** The agency portal. Private, authenticated, and not part of the public site. */
const PORTAL_ROOT = path.join(APP_ROOT, "(portal)");
/**
 * Tenant scheduling. Reached without an account, but not part of the public
 * site either: noindex, no navigation, and its own signed session.
 */
const SCHEDULE_ROOT = path.join(APP_ROOT, "(schedule)");
/**
 * Account setup: invitations and password resets.
 *
 * Reached **without any session**, which is the whole point — the person has
 * no password yet, or has forgotten it. It is not part of the public site
 * either: noindex, no navigation, no prices, and nothing on it is reachable
 * without a credential that was emailed. It is held to the *private* rules
 * below rather than the public ones, exactly like tenant scheduling.
 *
 * It legitimately imports the auth stack — it hashes a password and spends a
 * credential — and it legitimately has no `requireAdmin`/`requireAgent` call,
 * because there is nobody to be yet. What guards it is the credential itself.
 */
const ACCOUNT_ROOT = path.join(APP_ROOT, "(account)");
/**
 * The engineer's surface. Private, authenticated, and not part of the public
 * site: it carries an address, an access note and a tenant's phone number.
 */
const ENGINEER_ROOT = path.join(APP_ROOT, "engineer");

/**
 * Every authenticated surface, pages and API alike. Add one here when you add
 * one — the rules below are about what a *customer* can reach, and an endpoint
 * behind `requireAgent()` is not that.
 */
const PRIVATE_ROOTS = [
  ADMIN_ROOT,
  PORTAL_ROOT,
  SCHEDULE_ROOT,
  ACCOUNT_ROOT,
  ENGINEER_ROOT,
  path.join(APP_ROOT, "api", "schedule"),
  path.join(APP_ROOT, "api", "admin"),
  path.join(APP_ROOT, "api", "portal"),
  path.join(APP_ROOT, "api", "engineer"),
  /* Document downloads: one route, three audiences, permission from the row. */
  path.join(APP_ROOT, "api", "documents"),
  /*
    The scheduled worker. Not a page a customer renders and not something the
    public bundle can reach — it is an internal endpoint that authenticates
    either a scheduler's bearer token or a verified administrator, and it is
    held to the *private* rules below rather than the public ones.
  */
  path.join(APP_ROOT, "api", "cron"),
];

const isPrivate = (file: string) =>
  PRIVATE_ROOTS.some((root) => file.startsWith(root));

function filesUnder(directory: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, match));
    else if (match(entry.name)) found.push(full);
  }
  return found;
}

const read = (file: string) => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * The rules below are about what the code does, not about the notes
 * explaining why — a comment naming the route group must not trip the check
 * that no URL contains it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}
const relative = (file: string) => path.relative(ROOT, file);

describe("the admin gate", () => {
  const middleware = read(path.resolve(ROOT, "src/middleware.ts"));

  test("the matcher covers the admin pages and the admin API", () => {
    assert.match(middleware, /"\/admin\/:path\*"/);
    assert.match(middleware, /"\/api\/admin\/:path\*"/);
  });

  test("it covers nothing else", () => {
    /*
      The booking flow must not pass through authentication middleware. A
      matcher that widened to "/:path*" would put every customer request
      through this, and a mistake in it would take the public site down.

      Asserted as an allow-list of private prefixes rather than an exact list,
      because the prefixes grow as V2 surfaces land — but never to anything a
      customer can reach. `/schedule` is deliberately absent: tenant access is
      a token, not a session cookie, so gating it here would only imply it was
      gated.
    */
    const matcher = middleware.match(/matcher:[\s\S]*?\[([^\]]*)\]/)?.[1] ?? "";
    const entries = [...matcher.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    const privatePrefixes = ["/admin", "/api/admin", "/portal", "/api/portal", "/engineer", "/api/engineer", "/api/documents"];
    assert.ok(entries.length > 0, "the matcher is empty");
    assert.ok(entries.includes("/admin/:path*"));

    for (const entry of entries) {
      assert.ok(
        privatePrefixes.some((prefix) => entry.startsWith(`${prefix}/`)),
        `${entry} reaches outside the private surfaces`,
      );
    }

    for (const publicPath of ["/book", "/api/book", "/api/availability", "/api/hold", "/schedule", "/:path*"]) {
      assert.equal(
        entries.some((entry) => entry.startsWith(publicPath)),
        false,
        `the matcher covers ${publicPath}`,
      );
    }
  });

  test("an unauthenticated API call is refused, not redirected", () => {
    // Redirecting a fetch hands the caller an HTML login page with a 200 on
    // it, which is the kind of thing that gets parsed as success.
    assert.match(middleware, /startsWith\("\/api\/"\)/);
    assert.match(middleware, /status:\s*401/);
  });

  test("the login page stays reachable, or there is no way in", () => {
    assert.match(middleware, /"\/admin\/login"/);
  });

  test("the return path cannot become an open redirect", () => {
    // Only a path and query are carried, never an absolute URL.
    assert.match(middleware, /searchParams\.set\("next", `\$\{pathname\}\$\{search\}`\)/);

    const form = read(
      path.resolve(ROOT, "src/components/auth/CredentialsForm.tsx"),
    );
    assert.match(form, /startsWith\("\/\/"\)/);
    assert.match(form, /startsWith\("\/"\)/);
    // And it cannot carry somebody into the other audience's surface.
    assert.match(form, /startsWith\(home\)/);
  });

  test("the cookie check is documented as a gate, not as the authorisation", () => {
    // Middleware runs on the edge and cannot do the database and scrypt work a
    // real check needs. The comment is load-bearing: it tells the next person
    // why `requireAdmin` still exists.
    assert.match(middleware, /Authorisation is enforced again/i);
  });
});

describe("every admin page checks authorisation for itself", () => {
  const adminPages = filesUnder(ADMIN_ROOT, (name) => name === "page.tsx");

  test("there are admin pages to check", () => {
    assert.ok(adminPages.length > 0);
  });

  test("each one calls a guard, or is the login page", () => {
    /*
      The middleware matcher is a list someone has to remember to update. This
      is the check that does not depend on remembering: a page under /admin
      that never asks who is calling would be public the moment the matcher is
      wrong.
    */
    for (const file of adminPages) {
      const contents = read(file);
      if (file.endsWith(path.join("login", "page.tsx"))) {
        assert.match(contents, /currentSession/, `${relative(file)}`);
        continue;
      }
      assert.match(
        contents,
        /requireAdmin\(\)/,
        `${relative(file)} does not verify the session`,
      );
    }
  });
});

describe("every engineer page checks authorisation for itself", () => {
  const engineerPages = filesUnder(ENGINEER_ROOT, (name) => name === "page.tsx");

  test("there are engineer pages to check", () => {
    assert.ok(engineerPages.length > 0);
  });

  test("each one calls the engineer guard", () => {
    /*
      `requireEngineer()` admits an engineer or an administrator and nobody
      else. A page under /engineer that never asked who was calling would be
      public the moment the middleware matcher is wrong — and these pages
      carry an address, an access note and a tenant's number.
    */
    for (const file of engineerPages) {
      assert.match(
        read(file),
        /requireEngineer\(\)/,
        `${relative(file)} does not verify the session`,
      );
    }
  });

  test("its server actions verify the session too", () => {
    // A server action is a public HTTP endpoint with a generated name.
    const actions = filesUnder(ENGINEER_ROOT, (name) => name === "actions.ts");
    assert.ok(actions.length > 0, "no engineer actions were found to check");
    for (const file of actions) {
      const source = read(file);
      assert.match(source, /"use server"/, relative(file));
      for (const [, name] of source.matchAll(
        /export async function (\w+)\(/g,
      )) {
        const body = source.slice(source.indexOf(`export async function ${name}(`));
        assert.match(
          body.slice(0, body.indexOf("\n}")),
          /requireEngineer\(\)/,
          `${relative(file)}: ${name} does not verify the session`,
        );
      }
    }
  });

  test("its route handlers verify the session too", () => {
    /*
      The generator is served from inside the authenticated area rather than
      from `public/`, which means a route handler reads files off disk and
      returns them. It must ask who is calling exactly as a page does —
      anything under `public/` is served to whoever knows the path, and this
      deliberately is not.
    */
    const handlers = filesUnder(ENGINEER_ROOT, (name) => name === "route.ts");
    assert.ok(handlers.length > 0, "no engineer route handlers were found");
    for (const file of handlers) {
      assert.match(
        read(file),
        /requireEngineer(OrThrow)?\(\)/,
        `${relative(file)} does not verify the session`,
      );
    }
  });

  test("a handler that serves files names them, rather than joining a path", () => {
    // A request path joined onto a directory is a traversal waiting to be
    // found. An object lookup has nothing to traverse.
    const generator = path.join(
      ENGINEER_ROOT,
      "certificate",
      "[[...file]]",
      "route.ts",
    );
    const source = read(generator);
    assert.match(source, /const SERVABLE: Record<string,/);
    assert.match(source, /const entry = SERVABLE\[key\];/);
    assert.match(source, /if \(!entry\)/);
  });

  test("authenticated staff responses are never shared-cached", () => {
    // `private` at minimum, so no proxy or CDN holds a staff response.
    const handlers = filesUnder(ENGINEER_ROOT, (name) => name === "route.ts");
    for (const file of handlers) {
      const source = read(file);
      assert.match(source, /"Cache-Control"/, relative(file));
      assert.equal(
        /"Cache-Control":\s*"(?!private|no-store)/.test(source),
        false,
        `${relative(file)} may be cached by a shared cache`,
      );
    }
  });

  test("no engineer page is indexable", () => {
    for (const file of [
      ...engineerPages,
      path.join(ENGINEER_ROOT, "layout.tsx"),
    ]) {
      assert.match(read(file), /index: false/, relative(file));
    }
  });

  test("no money is rendered on the engineer's screens", () => {
    /*
      The engineer role carries neither `pricing:read` nor `invoice:read`. A
      restricted interface that happens to show an agency's negotiated rate
      is not restricted, and the query behind these pages deliberately selects
      no money column at all — this is the second line of that, against a
      page that later reaches for one.
    */
    const files = filesUnder(ENGINEER_ROOT, (name) => /\.tsx?$/.test(name));
    for (const file of files) {
      const source = withoutComments(read(file));
      for (const forbidden of [
        "priceTotalPence",
        "priceSnapshot",
        "unitPricePence",
        "listPricePence",
        "@/lib/pricing/",
        "@/lib/invoices/",
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `${relative(file)} reaches for ${forbidden}`,
        );
      }
      assert.equal(
        /£/.test(source),
        false,
        `${relative(file)} renders a price`,
      );
    }
  });
});

describe("the public site does not carry the admin stack", () => {
  const publicFiles = [
    ...filesUnder(APP_ROOT, (name) => /\.tsx?$/.test(name)),
    ...filesUnder(path.resolve(ROOT, "src/components"), (name) =>
      /\.tsx?$/.test(name),
    ),
  ].filter(
    (file) =>
      !isPrivate(file) &&
      !file.includes(".test.") &&
      // The shared sign-in form. It belongs to both private surfaces and is
      // reached from neither a public page nor a public component.
      !file.startsWith(path.resolve(ROOT, "src/components/auth")) &&
      !file.includes(".test.") &&
      // The Auth.js endpoint itself. It is the sign-in surface, not a page a
      // customer renders, and it exposes nothing but a credential check.
      !file.startsWith(path.join(APP_ROOT, "api", "auth")),
  );

  test("no public page or component imports the auth stack", () => {
    // Keeps Auth.js and the database out of the customer bundle entirely.
    for (const file of publicFiles) {
      const contents = read(file);
      for (const forbidden of [
        "next-auth",
        "@/auth",
        "@/lib/auth/",
        "@/lib/db/",
        "@/lib/settings/",
        "@/lib/invoices/",
        "@/lib/pricing/",
      ]) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relative(file)} imports ${forbidden}`,
        );
      }
    }
  });

  test("the booking API routes are untouched by authentication", () => {
    const bookingRoutes = [
      "src/app/api/book/route.ts",
      "src/app/api/availability/route.ts",
      "src/app/api/hold/route.ts",
      "src/app/api/hold/release/route.ts",
      "src/app/api/address/postcode/route.ts",
    ];
    for (const route of bookingRoutes) {
      const contents = read(path.resolve(ROOT, route));
      assert.equal(contents.includes("next-auth"), false, route);
      assert.equal(contents.includes("requireAdmin"), false, route);
    }
  });
});

describe("secrets and personal data stay out of the client", () => {
  test("nothing introduces a NEXT_PUBLIC_ variable", () => {
    // The V1 rule, still true: no credential and no service-area coordinate
    // may reach the browser.
    // Tests are excluded because this one has to contain the very string it
    // forbids in order to look for it.
    const sources = filesUnder(path.resolve(ROOT, "src"), (name) =>
      /\.tsx?$/.test(name),
    ).filter((file) => !file.includes(".test."));
    for (const file of sources) {
      assert.equal(
        read(file).includes("NEXT_PUBLIC_"),
        false,
        `${relative(file)} exposes an environment variable to the browser`,
      );
    }
  });

  test("server-only modules say so", () => {
    for (const file of [
      "src/lib/db/client.ts",
      "src/lib/auth/app-user.ts",
      "src/lib/auth/session.ts",
      "src/lib/settings/store.ts",
      "src/lib/invoices/allocate.ts",
    ]) {
      assert.match(
        read(path.resolve(ROOT, file)),
        /import "server-only"/,
        `${file} is not marked server-only`,
      );
    }
  });

  test("the credential check does not reveal which half was wrong", () => {
    // An admin login that distinguishes "no such user" from "wrong password"
    // is a list of who to attack.
    const source = read(path.resolve(ROOT, "src/lib/auth/app-user.ts"));
    assert.match(source, /DUMMY_HASH/);
    assert.match(source, /return null/);

    const form = read(
      path.resolve(ROOT, "src/components/auth/CredentialsForm.tsx"),
    );
    const messages = [...form.matchAll(/Those details were not recognised/g)];
    assert.equal(messages.length, 1, "more than one failure message exists");
  });
});


/**
 * The public site and the staff area render from different layouts.
 *
 * Before this split, `/admin/login` inherited the customer header, the footer
 * and the sticky "Book your CP12" bar — which covered the sign-in form on a
 * phone — and shipped the marketing bundle to an internal tool. Route groups
 * fixed it, and these assertions stop it drifting back.
 */
describe("the staff area does not render the public website", () => {
  const rootLayout = read(path.resolve(APP_ROOT, "layout.tsx"));
  const siteLayout = read(path.join(APP_ROOT, "(site)", "layout.tsx"));
  const adminLayout = read(path.join(ADMIN_ROOT, "layout.tsx"));

  test("the root layout is the document and nothing more", () => {
    // Anything rendered here reaches every route, including the staff area.
    for (const chrome of [
      "Header",
      "Footer",
      "StickyMobileCTA",
      "localBusinessSchema",
    ]) {
      assert.equal(
        rootLayout.includes(chrome),
        false,
        `the root layout still renders ${chrome}`,
      );
    }
    assert.match(rootLayout, /<html/);
    assert.match(rootLayout, /<body/);
  });

  test("the customer chrome lives in the public group", () => {
    for (const chrome of ["Header", "Footer", "StickyMobileCTA"]) {
      assert.ok(siteLayout.includes(chrome), `(site) is missing ${chrome}`);
    }
  });

  test("the admin layout renders none of it", () => {
    for (const chrome of [
      "Header",
      "Footer",
      "StickyMobileCTA",
      "localBusinessSchema",
    ]) {
      assert.equal(
        adminLayout.includes(chrome),
        false,
        `the admin layout renders ${chrome}`,
      );
    }
  });

  test("the route group is not a URL segment", () => {
    /*
      `(site)` exists only to group files. If a link or a canonical ever
      contained it, the group would have changed the site's URLs — which is
      exactly what it must not do.
    */
    const sources = filesUnder(path.resolve(ROOT, "src"), (name) =>
      /\.tsx?$/.test(name),
    ).filter((file) => !file.includes(".test."));

    for (const file of sources) {
      assert.equal(
        /["'`]\/?\(site\)/.test(withoutComments(read(file))),
        false,
        `${relative(file)} puts the route group in a URL`,
      );
    }
  });

  test("every public page still lives under the public group", () => {
    // A page added at src/app/<name>/page.tsx would silently lose the header.
    const strayPages = filesUnder(APP_ROOT, (name) => name === "page.tsx").filter(
      (file) =>
        !file.startsWith(path.join(APP_ROOT, "(site)")) && !isPrivate(file),
    );
    assert.deepEqual(
      strayPages.map(relative),
      [],
      "a page sits outside both the public group and the admin area",
    );
  });
});
