import { SearchXIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";

/** 404 doc.not_found: no such document in the active company (deleted, or it belongs to another company). Retrying would not help. */
export const isNotFound = (e: unknown) => e instanceof ApiError && e.problem.status === 404 && e.code === "doc.not_found";

export function NotFoundState({ listHref }: { listHref: string }) {
  const t = useTranslations("state");
  return (
    <Alert role="status">
      <SearchXIcon aria-hidden />
      <AlertTitle>{t("notFoundTitle")}</AlertTitle>
      <AlertDescription>{t("notFoundBody")}</AlertDescription>
      <div className="col-start-2 mt-2"><Button asChild size="sm" variant="outline"><Link href={listHref}>{t("notFoundBack")}</Link></Button></div>
    </Alert>
  );
}
