/**
 * HTML escaping for email bodies.
 *
 * Shared by the customer confirmation and the internal notification so there
 * is one implementation to get right. Every customer-controlled value — name,
 * address, email, access notes — goes through this before it reaches markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
