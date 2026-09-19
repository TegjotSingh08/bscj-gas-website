import type { InvoiceStatus } from "@/lib/invoices/model";

/**
 * Where an invoice is, in one word.
 *
 * The five states are kept visually distinct because they mean genuinely
 * different things — `sent` is "a provider accepted an email", not "it
 * arrived" and certainly not "it was paid", and a pill that blurred them would
 * be the first place that distinction was lost.
 */
const STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-navy-100 text-navy-700",
  issued: "bg-flame-400/20 text-flame-700",
  sent: "bg-flame-400/20 text-flame-700",
  paid: "bg-navy-900 text-white",
  void: "bg-navy-50 text-navy-500 line-through",
};

const LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  sent: "Sent",
  paid: "Paid",
  void: "Void",
};

export function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      data-testid="invoice-status"
      data-status={status}
      className={`inline-block rounded-full px-3 py-1 text-xs font-bold ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
