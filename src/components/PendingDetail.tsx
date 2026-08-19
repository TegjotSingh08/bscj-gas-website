/**
 * Renders a confirmed legal detail, or an unmissable marker when it has not
 * been supplied yet. Never invent these values.
 */
export function PendingDetail({
  value,
  label,
}: {
  value: string | null;
  label: string;
}) {
  if (value) return <>{value}</>;
  return (
    <mark className="rounded bg-flame-400/40 px-1.5 py-0.5 text-sm font-bold text-navy-900">
      [{label} — to be confirmed before launch]
    </mark>
  );
}
