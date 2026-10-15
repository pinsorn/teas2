import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton rows at the real row height (--row-h), so the page does not jump when data arrives. */
export function LoadingState({ rows = 6 }: { rows?: number }) {
  const t = useTranslations("common");
  return (
    <div role="status" aria-busy="true" data-screen-state="loading" className="flex flex-col gap-2">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-(--row-h)" />)}
    </div>
  );
}
