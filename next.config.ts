import type { NextConfig } from "next";

/**
 * Response headers.
 *
 * Deliberately the uncontroversial set. A full Content-Security-Policy needs
 * nonces for Next's inline bootstrap and real testing against the deployed
 * app; adding one blind before launch would risk a white page for a customer
 * mid-booking. It is recorded as post-launch work in LAUNCH_CHECKLIST.md
 * instead. HSTS is left to the host, which sets it on the apex domain.
 */
const securityHeaders = [
  // No MIME sniffing. The JSON-LD blocks and the API responses are the two
  // places a sniffed content type could matter.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing here should ever be framed — there is no embed use case, and a
  // framed booking form is a clickjacking target.
  { key: "X-Frame-Options", value: "DENY" },
  // Send the origin to third parties, never the full path. Booking URLs carry
  // no personal data, but the postcode endpoint is a POST from /book and the
  // referrer should not advertise the customer's journey.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The site asks for none of these, so nothing may.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // The framework version is not something a customer needs and not something
  // an attacker should be handed.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
