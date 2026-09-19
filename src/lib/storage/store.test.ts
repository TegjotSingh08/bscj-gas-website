import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The store's own contract, exercised against a real directory.
 *
 * The local driver is what development and the browser verification run
 * on, so it is worth testing for real rather than mocking. What is proved
 * here is the same contract the Blob driver has to keep: a key round-trips
 * to the same bytes, a key from anywhere else is refused, and a delete
 * touches exactly one object.
 */

let dir: string;
let store: typeof import("./documents");

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bscj-store-"));
  process.env.BSCJ_DOCUMENT_STORE = "local";
  process.env.BSCJ_DOCUMENT_DIR = dir;
  store = await import("./documents");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.BSCJ_DOCUMENT_STORE;
  delete process.env.BSCJ_DOCUMENT_DIR;
});

describe("the local driver", () => {
  test("configuration reports ready, with nothing outstanding", () => {
    const status = store.storageStatus();
    assert.equal(status.driver, "local");
    assert.equal(status.ready, true);
    assert.equal(status.requirement, null);
    assert.equal(store.isDriverImplemented(), true);
  });

  test("bytes round-trip exactly", async () => {
    const put = await store.putDocument(PDF);
    assert.equal(put.ok, true);
    if (!put.ok) return;

    const got = await store.getDocument(put.key);
    assert.equal(got.ok, true);
    if (got.ok) assert.deepEqual([...got.bytes], [...PDF]);
  });

  test("the key is opaque and unique", async () => {
    const a = await store.putDocument(PDF);
    const b = await store.putDocument(PDF);
    assert.equal(a.ok && b.ok, true);
    if (a.ok && b.ok) {
      assert.notEqual(a.key, b.key);
      assert.match(a.key, /^doc_[0-9a-f]{48}$/);
    }
  });

  test("a key from anywhere else cannot reach the filesystem", async () => {
    for (const key of ["../../../etc/passwd", "doc_short", "", "doc_" + "z".repeat(48)]) {
      const got = await store.getDocument(key);
      assert.equal(got.ok, false, key);
      const removed = await store.deleteDocument(key);
      assert.equal(removed.ok, false, key);
    }
  });

  test("deleting removes exactly the one object", async () => {
    // The compensating path: one key, and nothing else in the store moves.
    const keep = await store.putDocument(PDF);
    const drop = await store.putDocument(PDF);
    assert.ok(keep.ok && drop.ok);
    if (!keep.ok || !drop.ok) return;

    const before = (await readdir(dir)).length;
    const removed = await store.deleteDocument(drop.key);
    assert.equal(removed.ok, true);

    const after = await readdir(dir);
    assert.equal(after.length, before - 1);
    assert.ok(after.includes(keep.key), "it removed the wrong object");
    assert.equal((await store.getDocument(keep.key)).ok, true);
    assert.equal((await store.getDocument(drop.key)).ok, false);
  });

  test("an unrelated file in the directory is never touched", async () => {
    // Nothing enumerates or sweeps the store, so a stranger's file survives.
    await writeFile(path.join(dir, "not-ours.txt"), "leave me");
    const doomed = await store.putDocument(PDF);
    assert.ok(doomed.ok);
    if (doomed.ok) await store.deleteDocument(doomed.key);
    assert.ok((await readdir(dir)).includes("not-ours.txt"));
  });
});

describe("configuration states", () => {
  test("no driver selected says so, and names both ways out", () => {
    const saved = process.env.BSCJ_DOCUMENT_STORE;
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BSCJ_DOCUMENT_STORE;
    delete process.env.BLOB_READ_WRITE_TOKEN;

    const status = store.storageStatus();
    assert.equal(status.driver, "none");
    assert.equal(status.ready, false);
    assert.match(status.requirement ?? "", /BSCJ_DOCUMENT_STORE/);
    assert.match(status.requirement ?? "", /BLOB_READ_WRITE_TOKEN/);
    assert.equal(store.isDriverImplemented(), false);

    if (saved) process.env.BSCJ_DOCUMENT_STORE = saved;
    if (token) process.env.BLOB_READ_WRITE_TOKEN = token;
  });

  test("the Blob driver without a token is implemented, not absent", () => {
    /*
      The distinction a deployment turns on: one is a setting, the other
      would be a release.
    */
    const saved = process.env.BSCJ_DOCUMENT_STORE;
    process.env.BSCJ_DOCUMENT_STORE = "vercel-blob";
    delete process.env.BLOB_READ_WRITE_TOKEN;

    const status = store.storageStatus();
    assert.equal(status.driver, "vercel-blob");
    assert.equal(status.ready, false);
    assert.equal(store.isDriverImplemented(), true, "reported as absent");
    assert.match(status.requirement ?? "", /implemented but has no credentials/);
    assert.match(status.requirement ?? "", /BLOB_READ_WRITE_TOKEN/);

    if (saved) process.env.BSCJ_DOCUMENT_STORE = saved;
  });

  test("a store that is not ready stores nothing", async () => {
    const saved = process.env.BSCJ_DOCUMENT_STORE;
    process.env.BSCJ_DOCUMENT_STORE = "vercel-blob";
    delete process.env.BLOB_READ_WRITE_TOKEN;

    const put = await store.putDocument(PDF);
    assert.equal(put.ok, false);
    if (!put.ok) assert.match(put.error, /credentials/i);

    if (saved) process.env.BSCJ_DOCUMENT_STORE = saved;
  });
});
