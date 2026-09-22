import "server-only";

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { blobDelete, blobGet, blobPut } from "./blob";

/**
 * Where certificate PDFs live.
 *
 * **Private, always.** No document is ever a public URL. A key is opaque,
 * carries no customer detail, and is never rendered into a page — every read
 * goes through an authenticated route that re-derives the caller's
 * permission from the database first.
 *
 * Two drivers, chosen by configuration:
 *
 * - **`local`** — a directory on the machine. Implemented here, and what the
 *   fixtures and the browser verification run against. It refuses to load in
 *   production, because a serverless filesystem is ephemeral and a
 *   certificate that vanishes on the next deploy is worse than one that was
 *   never stored.
 * - **`vercel-blob`** — the production store (V2_ARCHITECTURE §11).
 *   **Implemented**, in `blob.ts`, always with `access: "private"`. It has
 *   not been run against a real store — no store has been provisioned and
 *   no token issued — so `storageStatus()` distinguishes *implemented but
 *   uncredentialled* from *absent*, and says which.
 *
 * The rest of the application only ever sees `putDocument` / `getDocument`,
 * so the driver can be replaced without touching an upload, a review or a
 * download.
 */

export type StorageDriver = "local" | "vercel-blob" | "none";

export type StorageStatus = {
  driver: StorageDriver;
  ready: boolean;
  /** What a person has to do to make it ready. Empty when it is. */
  requirement: string | null;
};

const LOCAL_DIR_VAR = "BSCJ_DOCUMENT_DIR";

function configuredDriver(): StorageDriver {
  const declared = process.env.BSCJ_DOCUMENT_STORE;
  if (declared === "local") return "local";
  if (declared === "vercel-blob") return "vercel-blob";
  /*
    A token on its own selects the Blob driver. That is what a production
    deployment looks like: the platform injects `BLOB_READ_WRITE_TOKEN`
    when a store is attached, and nobody should have to remember a second
    variable for the deployment to work.
  */
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  return "none";
}

/** The Blob token, or null. Never logged and never returned to a caller. */
function blobToken(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token && token.trim() !== "" ? token : null;
}

/**
 * Whether documents can be stored at all, and what is missing if not.
 *
 * Every screen that offers an upload asks this first and says the answer
 * out loud. An upload button that fails at the end of the request is worse
 * than one that was never offered.
 */
export function storageStatus(): StorageStatus {
  const driver = configuredDriver();

  if (driver === "local") {
    if (process.env.NODE_ENV === "production") {
      return {
        driver,
        ready: false,
        requirement:
          "The local document store is development-only and refuses to run in production. Configure the Blob driver instead.",
      };
    }
    if (!process.env[LOCAL_DIR_VAR]) {
      return {
        driver,
        ready: false,
        requirement: `Set ${LOCAL_DIR_VAR} to a writable directory.`,
      };
    }
    return { driver, ready: true, requirement: null };
  }

  if (driver === "vercel-blob") {
    /*
      The distinction the deployment checklist turns on. "Implemented,
      uncredentialled" is one environment variable away from working;
      "absent" would be a code change. Reporting them the same way is how
      somebody spends an afternoon looking for a bug that is a setting.
    */
    if (!blobToken()) {
      return {
        driver,
        ready: false,
        requirement:
          "The Vercel Blob adapter is implemented but has no credentials. Create a Blob store in the Vercel project and set BLOB_READ_WRITE_TOKEN. No other change is needed.",
      };
    }
    return { driver, ready: true, requirement: null };
  }

  return {
    driver: "none",
    ready: false,
    requirement:
      "No document store is configured. Set BSCJ_DOCUMENT_STORE=local with BSCJ_DOCUMENT_DIR for development, or attach a Vercel Blob store so BLOB_READ_WRITE_TOKEN is present.",
  };
}

/**
 * Whether the adapter for the configured driver exists in the code at all.
 *
 * Separate from `ready` on purpose: a screen can say "this needs a setting"
 * rather than "this needs a release", and those are different conversations.
 */
export function isDriverImplemented(): boolean {
  const driver = configuredDriver();
  return driver === "local" || driver === "vercel-blob";
}

export function isStorageReady(): boolean {
  return storageStatus().ready;
}

/**
 * A new opaque key.
 *
 * Random, not derived from the job, the reference, the property or the
 * filename. A key that encodes anything is a key that leaks it the moment it
 * appears in a log line — and keys do end up in log lines.
 */
export function newDocumentKey(): string {
  return `doc_${randomBytes(24).toString("hex")}`;
}

/**
 * A key that is the same every time for the same attempt.
 *
 * **Why this exists.** A submission that is interrupted after the object is
 * stored but before the row is written leaves a PDF nobody can find again. A
 * random key makes that unrecoverable: the retry has no way to ask "did my
 * own previous attempt already store this?", so it either stores a second
 * copy for an administrator to choose between, or guesses from timestamps and
 * risks adopting an unrelated document.
 *
 * Deriving the key from the attempt removes the question. The retry computes
 * the same key, writes the same object — the store overwrites it with
 * identical bytes — and the unique index on `blob_key` turns the second
 * insert into a lookup of the first. Idempotency comes from the database
 * rather than from timing.
 *
 * **It still encodes nothing.** The seed is hashed, so the key carries no job
 * reference, no name and no address — the property the comment above is about.
 * It is not a secret either: every document is served by its own id behind an
 * authorisation check, and the store is private on both drivers.
 */
export function derivedDocumentKey(seed: string): string {
  return `doc_${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}

/** Keys this module minted. Anything else is not ours to open. */
const KEY_SHAPE = /^doc_[0-9a-f]{48}$/;

function localRoot(): string {
  const dir = process.env[LOCAL_DIR_VAR];
  if (!dir) throw new Error("The local document store has no directory configured.");
  return dir;
}

export type PutResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

/**
 * Stores the bytes and returns the key.
 *
 * Never throws for an ordinary failure — a full disk, a missing directory, a
 * driver that is not configured. The caller has a person in front of it and
 * needs to say what happened, not a stack trace. **Nothing is written to the
 * database until this has succeeded**, so a storage failure leaves no row
 * claiming a file that is not there.
 */
export async function putDocument(
  bytes: Uint8Array,
  options: {
    /**
     * Store under this key rather than a fresh random one.
     *
     * For a caller that needs the same attempt to land in the same place
     * twice — see `derivedDocumentKey`. Refused unless it has the shape this
     * module mints, so a caller cannot write outside the store's namespace.
     */
    key?: string;
  } = {},
): Promise<PutResult> {
  const status = storageStatus();
  if (!status.ready) {
    return { ok: false, error: status.requirement ?? "No document store is configured." };
  }

  if (options.key && !KEY_SHAPE.test(options.key)) {
    return { ok: false, error: "That document key is not one this store mints." };
  }
  const key = options.key ?? newDocumentKey();

  if (status.driver === "local") {
    try {
      const root = localRoot();
      await mkdir(root, { recursive: true });
      /*
        Written to a temporary name and then moved would be better still;
        `writeFile` is used because a partial write here cannot be mistaken
        for a stored document — the database row is only written after this
        resolves, so a half-written file is orphaned rather than referenced.
      */
      await writeFile(path.join(root, key), bytes, { mode: 0o600 });
      return { ok: true, key };
    } catch {
      return { ok: false, error: "The document could not be stored. Nothing was recorded." };
    }
  }

  if (status.driver === "vercel-blob") {
    const token = blobToken()!;
    const stored = await blobPut(key, bytes, token);
    if (!stored.ok) {
      return {
        ok: false,
        error: "The document could not be stored. Nothing was recorded.",
      };
    }
    return { ok: true, key };
  }

  return { ok: false, error: status.requirement ?? "No document store is configured." };
}

export type DeleteResult = { ok: boolean; error?: string };

/**
 * Removes one stored object, by a key this module minted.
 *
 * **The only caller is the compensating path in `uploadCertificate`**, where
 * the bytes were stored and the database row then failed to write. Without
 * it every failed upload would leave a paid-for object nobody can reach.
 *
 * Bounded by construction rather than by a limit:
 *
 * - it takes **one key**, never a prefix, a pattern or a list;
 * - the key must match the shape this module mints, so a value from
 *   anywhere else cannot reach a delete;
 * - the caller passes the key it *just created in this request*, which is
 *   by definition not referenced by any row and cannot be a released
 *   certificate.
 *
 * There is deliberately **no sweep** over the store. A sweep would have to
 * decide "unreferenced" from a database read, and a read that failed or
 * returned a partial answer would delete issued certificates. An orphaned
 * object costs a fraction of a penny; a deleted safety record cannot be
 * recovered. When this fails, the key is recorded so it can be removed by
 * hand.
 */
export async function deleteDocument(key: string): Promise<DeleteResult> {
  if (!KEY_SHAPE.test(key)) return { ok: false, error: "Not a document key." };

  const status = storageStatus();
  if (!status.ready) return { ok: false, error: "No document store is configured." };

  if (status.driver === "local") {
    try {
      await unlink(path.join(localRoot(), key));
      return { ok: true };
    } catch {
      return { ok: false, error: "The object could not be removed." };
    }
  }

  if (status.driver === "vercel-blob") {
    const removed = await blobDelete(key, blobToken()!);
    return removed.ok ? { ok: true } : { ok: false, error: removed.error };
  }

  return { ok: false, error: "No document store is configured." };
}

export type GetResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Reads a stored document.
 *
 * The key is checked against the shape this module mints before it reaches
 * a filesystem call, so a key from anywhere else — a hand-edited row, a
 * future driver, a mistake — cannot become a path.
 */
export async function getDocument(key: string): Promise<GetResult> {
  if (!KEY_SHAPE.test(key)) {
    return { ok: false, error: "Not a document key." };
  }

  const status = storageStatus();
  if (!status.ready) {
    return { ok: false, error: status.requirement ?? "No document store is configured." };
  }

  if (status.driver === "local") {
    try {
      const bytes = await readFile(path.join(localRoot(), key));
      return { ok: true, bytes: new Uint8Array(bytes) };
    } catch {
      return { ok: false, error: "That document could not be read from storage." };
    }
  }

  if (status.driver === "vercel-blob") {
    const found = await blobGet(key, blobToken()!);
    if (!found.ok) {
      return { ok: false, error: "That document could not be read from storage." };
    }
    return { ok: true, bytes: found.value };
  }

  return { ok: false, error: status.requirement ?? "No document store is configured." };
}
