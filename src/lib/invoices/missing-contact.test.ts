import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What an operation needs, versus what a record holds.
 *
 * The rule migration 0008 embodies: a landlord may be *recorded* without
 * contact details, and the requirement moves to the operation that actually
 * has to reach somebody. These assert that the moving happened — that nothing
 * blanket-requires a contact, and that the operations which genuinely need one
 * refuse by name rather than substituting a different recipient.
 */

const read = (file: string) =>
  readFileSync(path.resolve(process.cwd(), file), "utf8");

function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("recording needs no contact", () => {
  test("the landlord parser requires only a name", () => {
    const source = code(read("src/lib/portfolio/validation.ts"));
    const parser = source.slice(source.indexOf("export function parseLandlord"));
    const body = parser.slice(0, parser.indexOf("export function parseProperty"));
    // A name is still required; neither contact field is.
    assert.match(body, /errors\.name/);
    assert.equal(/errors\.email = "Enter a valid email address\."/.test(body), false);
    assert.equal(/errors\.phone = "Enter a contact number\."/.test(body), false);
  });

  test("the importer's landlord contact columns are optional", () => {
    const source = read("src/lib/portfolio/import/columns.ts");
    for (const key of ["landlordEmail", "landlordPhone"]) {
      const at = source.indexOf(`key: "${key}"`);
      assert.ok(at > 0, key);
      const spec = source.slice(at, at + 200);
      assert.match(spec, /required: false/, key);
    }
    // The owner's *name* stays required: a property belongs to somebody.
    const nameAt = source.indexOf('key: "landlordName"');
    assert.match(source.slice(nameAt, nameAt + 200), /required: true/);
  });
});

describe("acting needs exactly what that act needs", () => {
  test("a payer with no email is still an eligible payer", () => {
    /*
      Who pays is a question about the commercial relationship, not about
      whether we happen to hold an email. Removing the right payer from the
      list would invite somebody to pick the wrong one.
    */
    const source = read("src/lib/invoices/invoices.ts");
    const at = source.indexOf("export type EligiblePayer");
    const type = source.slice(at, at + 900);
    assert.match(type, /email: string \| null/);
  });

  test("certificate release refuses by name when an address is missing", () => {
    const source = read("src/lib/documents/certificates.ts");
    assert.match(source, /No email address is on file for/);

    /*
      And refuses *before* queueing, not after. Compared against the call site
      rather than the first occurrence of the name — which is the import, and
      is always at the top of the file.
    */
    const refusal = source.indexOf("No email address is on file for");
    const queue = source.indexOf("const rows = certificateRows({");
    assert.ok(queue > 0, "the queueing call should be findable");
    assert.ok(refusal < queue, "the refusal must precede the queueing");
  });

  test("invoice delivery reports a recipient with no address rather than dropping it", () => {
    // The recipient is still offered and labelled; what is absent is the
    // address, and that is what blocks the send.
    const source = read("src/lib/invoices/delivery.ts");
    assert.match(source, /address: row\.payerEmail \?\? null/);
  });

  test("the agency is a separate labelled recipient, never a silent substitute", () => {
    /*
      Owner, payer and recipient are three different things. Falling back to
      the agency when a landlord has no address would quietly send a
      landlord's certificate to their agent.
    */
    const source = read("src/lib/invoices/delivery.ts");
    assert.match(source, /recipient: "customer"/);
    assert.match(source, /recipient: "agent"/);
    // No fallback chain from one to the other.
    assert.equal(/payerEmail \?\? row\.organisationEmail/.test(source), false);
  });
});

describe("consumer booking is untouched", () => {
  test("the public booking schema still requires both contact details", () => {
    /*
      A private customer books, pays and receives the certificate themselves.
      Nothing in 0008 relaxes that path — the nullability is for records
      created from an agency's portfolio.
    */
    const source = read("src/lib/booking/schema.ts");
    assert.match(source, /email/);
    assert.match(source, /phone/);
    const validation = code(read("src/lib/booking/contact.ts"));
    assert.match(validation, /normaliseEmail/);
    assert.match(validation, /normaliseUkMobile/);
  });
});

describe("a blank contact never merges two landlords", () => {
  test("the match is guarded on a non-empty email", () => {
    /*
      Two landlords with no email are two landlords. Matching on a blank would
      collapse every contactless landlord in a portfolio into whichever one the
      first import created, taking their properties with them.
    */
    const source = code(read("src/lib/portfolio/mutations.ts"));
    const at = source.indexOf("export async function createLandlord");
    const body = source.slice(at, source.indexOf("export async function updateLandlord"));
    assert.match(body, /if \(input\.email\)/);
  });

  test("name matching is never done implicitly in the write path", () => {
    // It belongs to the importer, which reports an ambiguous name instead of
    // picking. A silent name match in the mutation would bypass that.
    const source = code(read("src/lib/portfolio/mutations.ts"));
    const at = source.indexOf("export async function createLandlord");
    const body = source.slice(at, source.indexOf("export async function updateLandlord"));
    assert.equal(/eq\(customers\.name/.test(body), false);
  });
});
