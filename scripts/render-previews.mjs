/**
 * Renders the tenant-facing emails to files, with fictional content.
 *
 * Development only, and it **sends nothing**: it calls the renderers and
 * writes their HTML and plain-text output to `previews/`, which is ignored by
 * git. Nothing here touches a transport, a database or a real address — every
 * value below is invented.
 *
 *   npm run previews
 */
import { writeFileSync, mkdirSync } from "node:fs";

const { renderTenantInvitationEmail, renderTenantAppointmentEmail } =
  await import("../src/lib/email/tenant-scheduling.ts");

mkdirSync("previews", { recursive: true });

const common = {
  reference: "BSCJ-FIXTURE",
  address: "Flat 2, 14 Fixture Street",
  postcode: "WV1 1AA",
  productName: "Gas Safety Certificate (CP12)",
  appointmentMinutes: 45,
  organisationName: "Fixture Lettings",
  timeZone: "Europe/London",
};

const emails = [
  [
    "tenant-invitation",
    renderTenantInvitationEmail({
      ...common,
      link: "https://bscj-v2-pilot.vercel.app/schedule/" + "f".repeat(64),
      expiresAt: new Date("2026-12-20T09:00:00Z"),
    }),
  ],
  [
    "tenant-appointment-confirmation",
    renderTenantAppointmentEmail({
      ...common,
      appointmentStart: new Date("2026-10-02T09:30:00Z"),
      appointmentEnd: new Date("2026-10-02T10:15:00Z"),
    }),
  ],
];

for (const [name, email] of emails) {
  writeFileSync(`previews/${name}.html`, email.html);
  writeFileSync(
    `previews/${name}.txt`,
    `Subject: ${email.subject}\nPreheader: ${email.preheader}\n\n${email.text}\n`,
  );
  console.log(`previews/${name}.html  (${email.html.length} bytes)`);
  console.log(`previews/${name}.txt`);
}

/*
  A side-by-side page, so light and dark can be compared at a glance and at
  phone width. `color-scheme` on each frame is what makes a client's dark
  treatment visible here rather than only on a real device.
*/
/*
  The email is inlined with `srcdoc` rather than linked with `src`, so the
  index is self-contained and renders anywhere — a preview that only works
  when served from its own directory is a preview that gets looked at once.
*/
const frame = (name, html, scheme) => `
<figure style="margin:0;flex:1 1 380px;min-width:340px;">
  <figcaption style="font:600 13px system-ui;padding:8px 0;color:#0b1b30;">
    ${name} — ${scheme}
  </figcaption>
  <div style="color-scheme:${scheme};background:${scheme === "dark" ? "#1a1a1a" : "#f2f6fb"};padding:8px;border-radius:12px;">
    <iframe srcdoc="${html.replace(/"/g, "&quot;")}" style="width:100%;height:720px;border:0;border-radius:8px;" title="${name} ${scheme}"></iframe>
  </div>
</figure>`;

writeFileSync(
  "previews/index.html",
  `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BSCJ tenant email previews</title></head>
<body style="margin:0;padding:16px;font:14px system-ui;background:#fff;">
<h1 style="font-size:18px;margin:0 0 4px;">Tenant email previews</h1>
<p style="margin:0 0 16px;color:#555;">Fictional content. Nothing was sent.</p>
<div style="display:flex;flex-wrap:wrap;gap:16px;">
${emails.map(([n, e]) => frame(n, e.html, "light") + frame(n, e.html, "dark")).join("")}
</div>
</body></html>`,
);
console.log("previews/index.html");

/*
  The mobile pages are not rendered here: they need a running server and a real
  browser, so they are captured by hand into `previews/` when the shell or the
  confirmation page changes. `npm run previews` covers the emails, which are
  pure functions and can be rendered without either.
*/
