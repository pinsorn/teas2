import { useTranslations } from "next-intl";
import type { DocStatus } from "@/domain/types";
import { cn } from "@/lib/utils";

// Colours come only from tokens.css (--color-status-*). A chip always carries its text label (never colour alone).
const TONE = {
  draft: "text-(--color-status-draft-fg) bg-(--color-status-draft-bg)",
  pending: "text-(--color-status-pending-fg) bg-(--color-status-pending-bg)",
  approved: "text-(--color-status-approved-fg) bg-(--color-status-approved-bg)",
  issued: "text-(--color-status-issued-fg) bg-(--color-status-issued-bg)",
  partly_settled: "text-(--color-status-partly-fg) bg-(--color-status-partly-bg)",
  settled: "text-(--color-status-settled-fg) bg-(--color-status-settled-bg)",
  cancelled: "text-(--color-status-cancelled-fg) bg-(--color-status-cancelled-bg)",
  replaced: "text-(--color-status-cancelled-fg) bg-(--color-status-cancelled-bg)",
  overdue: "text-(--color-status-overdue-fg) bg-(--color-status-overdue-bg)",
} satisfies Record<DocStatus | "overdue", string>;

/** Overdue is derived from the due date, shown as an extra chip next to the stored status, never as a status. */
export function StatusChip({ status, className }: { status: DocStatus | "overdue"; className?: string }) {
  const t = useTranslations("status");
  return (
    <span
      data-status={status}
      className={cn("inline-flex h-6 items-center rounded-md px-2.5 text-small font-medium whitespace-nowrap", TONE[status], className)}
    >
      {t(status)}
    </span>
  );
}
