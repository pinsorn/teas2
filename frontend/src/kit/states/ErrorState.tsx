import { TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";

/** A failed request. Never rendered as "no data": names the problem, offers retry, shows the trace id for support. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations("state");
  const tc = useTranslations("problem");
  const p = error instanceof ApiError ? error.problem : undefined;
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>{t("errorTitle")}</AlertTitle>
      <AlertDescription className="text-foreground!">
        {p?.title ?? tc("default")}
        {p?.traceId ? <> <span className="text-muted-foreground tabular-nums">{t("trace", { id: p.traceId })}</span></> : null}
      </AlertDescription>
      <AlertAction><Button size="sm" variant="outline" onClick={onRetry}>{t("retry")}</Button></AlertAction>
    </Alert>
  );
}
