/**
 * Stand-in for `next/headers` when route handlers are unit tested.
 *
 * Like `next-server-stub.mjs`, this exists because the specifier only resolves
 * inside the Next runtime. A test that cares about the request store replaces
 * this with `mock.module`; this only has to be importable, and to fail loudly
 * rather than silently if a test forgets to.
 */
function outsideRequest(name) {
  return () => {
    throw new Error(
      `${name}() was called outside a request. Mock "next/headers" in this test.`,
    );
  };
}

export const cookies = outsideRequest("cookies");
export const headers = outsideRequest("headers");
export const draftMode = outsideRequest("draftMode");
