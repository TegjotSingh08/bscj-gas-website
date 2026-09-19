import { openCredentialLink } from "../../open-link";

export const dynamic = "force-dynamic";

/**
 * The invitation link.
 *
 * A Route Handler rather than a page because it writes a cookie, which Next
 * refuses during an ordinary render — and because the whole point is to get
 * the token *out* of the URL before anything renders.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return openCredentialLink(request, token, "invitation");
}
