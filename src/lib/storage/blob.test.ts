import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Blob adapter, against a mock shaped like the SDK.
 *
 * **This is not verification against the live service.** No store has been
 * provisioned and no token issued, so nothing here proves Vercel accepts
 * these calls. What it does prove is the half that is ours: that the
 * adapter passes `access: "private"` every time, that it reads a stream
 * back into the right bytes, that a failure is returned rather than thrown,
 * and that delete is reachable only with a single key.
 *
 * The mock mirrors `@vercel/blob@2.8`: `put` resolves to an object with a
 * `pathname`, `get` resolves to `{ statusCode, stream, blob }` or null, and
 * `del` resolves to void — all of them throwing typed errors on failure.
 */

type PutCall = { pathname: string; options: Record<string, unknown> };
type GetCall = { pathname: string; options: Record<string, unknown> };

const putCalls: PutCall[] = [];
const getCalls: GetCall[] = [];
const delCalls: string[] = [];

/** What the next call should do. Set per test. */
let putBehaviour: "ok" | "throw" = "ok";
let getBehaviour: "ok" | "missing" | "notModified" | "throw" = "ok";
let delBehaviour: "ok" | "throw" = "ok";
let storedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

/** A web ReadableStream in the two chunks a real response would arrive in. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const half = Math.ceil(bytes.byteLength / 2);
  const chunks = [bytes.subarray(0, half), bytes.subarray(half)];
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

class BlobUnknownError extends Error {
  constructor() {
    super("Vercel Blob: Unknown error");
    this.name = "BlobUnknownError";
  }
}

mock.module("@vercel/blob", {
  namedExports: {
    put: async (pathname: string, _body: unknown, options: Record<string, unknown>) => {
      putCalls.push({ pathname, options });
      if (putBehaviour === "throw") throw new BlobUnknownError();
      return { pathname, url: `https://store.example/${pathname}` };
    },
    get: async (pathname: string, options: Record<string, unknown>) => {
      getCalls.push({ pathname, options });
      if (getBehaviour === "throw") throw new BlobUnknownError();
      if (getBehaviour === "missing") return null;
      if (getBehaviour === "notModified") {
        return { statusCode: 304, stream: null, headers: new Headers(), blob: {} };
      }
      return {
        statusCode: 200,
        stream: streamOf(storedBytes),
        headers: new Headers(),
        blob: { contentType: "application/pdf", size: storedBytes.byteLength },
      };
    },
    del: async (pathname: string) => {
      delCalls.push(pathname);
      if (delBehaviour === "throw") throw new BlobUnknownError();
    },
  },
});

const { blobDelete, blobGet, blobPathname, blobPut, BLOB_PREFIX } = await import("./blob");

const KEY = `doc_${"a".repeat(48)}`;

function reset() {
  putCalls.length = 0;
  getCalls.length = 0;
  delCalls.length = 0;
  putBehaviour = "ok";
  getBehaviour = "ok";
  delBehaviour = "ok";
}

describe("storing", () => {
  test("every write is private, and that is not a variable", () => {
    reset();
    return blobPut(KEY, new Uint8Array([1, 2, 3]), "tok").then((result) => {
      assert.equal(result.ok, true);
      assert.equal(putCalls.length, 1);
      assert.equal(putCalls[0].options.access, "private");
    });
  });

  test("it writes under the application's own prefix, with the key as the name", async () => {
    reset();
    await blobPut(KEY, new Uint8Array([1]), "tok");
    assert.equal(putCalls[0].pathname, `${BLOB_PREFIX}${KEY}`);
    assert.equal(blobPathname(KEY), `${BLOB_PREFIX}${KEY}`);
  });

  test("it never adds a random suffix and never overwrites", async () => {
    /*
      The key is already unique. A suffix would make the pathname
      unpredictable to us as well, and an overwrite would destroy a
      certificate rather than fail.
    */
    reset();
    await blobPut(KEY, new Uint8Array([1]), "tok");
    assert.equal(putCalls[0].options.addRandomSuffix, false);
    assert.equal(putCalls[0].options.allowOverwrite, false);
    assert.equal(putCalls[0].options.contentType, "application/pdf");
  });

  test("the token is passed, never read from ambient state by this module", async () => {
    reset();
    await blobPut(KEY, new Uint8Array([1]), "a-token");
    assert.equal(putCalls[0].options.token, "a-token");
  });

  test("an SDK error is returned, not thrown", async () => {
    reset();
    putBehaviour = "throw";
    const result = await blobPut(KEY, new Uint8Array([1]), "tok");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "BlobUnknownError");
  });
});

describe("reading", () => {
  test("the stream is reassembled into exactly the stored bytes", async () => {
    reset();
    storedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7, 6, 5]);
    const result = await blobGet(KEY, "tok");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual([...result.value], [...storedBytes]);
  });

  test("a large body split across many chunks still round-trips", async () => {
    reset();
    storedBytes = new Uint8Array(5000).map((_, i) => i % 251);
    const result = await blobGet(KEY, "tok");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.byteLength, 5000);
      assert.deepEqual([...result.value.subarray(0, 8)], [...storedBytes.subarray(0, 8)]);
      assert.deepEqual([...result.value.subarray(-8)], [...storedBytes.subarray(-8)]);
    }
  });

  test("reads bypass the cache", async () => {
    // A stale read after a correction would hand somebody the wrong version.
    reset();
    await blobGet(KEY, "tok");
    assert.equal(getCalls[0].options.useCache, false);
    assert.equal(getCalls[0].options.access, "private");
  });

  test("a missing blob is a failure, not empty bytes", async () => {
    reset();
    getBehaviour = "missing";
    const result = await blobGet(KEY, "tok");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "not_found");
  });

  test("a 304 is not mistaken for a body", async () => {
    reset();
    getBehaviour = "notModified";
    const result = await blobGet(KEY, "tok");
    assert.equal(result.ok, false);
  });

  test("an SDK error is returned, not thrown", async () => {
    reset();
    getBehaviour = "throw";
    const result = await blobGet(KEY, "tok");
    assert.equal(result.ok, false);
  });
});

describe("deleting", () => {
  test("it removes exactly one pathname, under our prefix", async () => {
    reset();
    const result = await blobDelete(KEY, "tok");
    assert.equal(result.ok, true);
    assert.deepEqual(delCalls, [`${BLOB_PREFIX}${KEY}`]);
  });

  test("a failed delete is reported rather than thrown", async () => {
    reset();
    delBehaviour = "throw";
    const result = await blobDelete(KEY, "tok");
    assert.equal(result.ok, false);
  });
});

describe("what the adapter can never do", () => {
  const SOURCE = readFileSync(
    path.resolve(process.cwd(), "src/lib/storage/blob.ts"),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  test("public access appears nowhere in the code", () => {
    /*
      A public blob is a URL that works for anyone who ever sees it, with no
      way to withdraw it. There is no option, no variable and no fallback
      that produces one.
    */
    assert.equal(code.includes('"public"'), false);
    assert.equal(code.includes("'public'"), false);
    assert.equal((code.match(/access: "private"/g) ?? []).length >= 2, true);
  });

  test("delete takes a single key and cannot be handed a prefix or a list", () => {
    const fn = code.slice(code.indexOf("export async function blobDelete"));
    assert.match(fn, /key: string/);
    assert.equal(/key: string\[\]/.test(fn), false);
    assert.equal(fn.includes("list("), false);
    assert.equal(fn.includes("BLOB_PREFIX,"), false);
  });

  test("the module never imports the list API", () => {
    // There is no sweep, by construction: it cannot enumerate the store.
    assert.match(code, /import \{ del, get, put \} from "@vercel\/blob"/);
  });
});
