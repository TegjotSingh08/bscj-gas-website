/**
 * Stand-in for `next/cache` when server actions are exercised outside Next.
 *
 * Like the `next/server` and `next/headers` stubs, this exists because the
 * specifier only resolves inside the Next runtime. Unlike them it does **not**
 * throw: revalidating a path is housekeeping that happens *after* the work a
 * test is interested in, and a server action that has already written should
 * not be reported as failing because a cache hint had nowhere to go.
 *
 * Calls are recorded so a test that does care can assert on them.
 */

/** Every path revalidated since the last `clearRevalidations()`. */
export const revalidated = { paths: [], tags: [] };

export function revalidatePath(path) {
  revalidated.paths.push(path);
}

export function revalidateTag(tag) {
  revalidated.tags.push(tag);
}

export function clearRevalidations() {
  revalidated.paths.length = 0;
  revalidated.tags.length = 0;
}

export function unstable_cache(fn) {
  return fn;
}
