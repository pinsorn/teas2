import { ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** 403: says which permission is missing (the server's `detail`, else the permission the screen needs) and who can grant it. */
export function ForbiddenState({ permission, detail }: { permission?: string; detail?: string }) {
  const t = useTranslations("state");
  return (
    <Alert role="status">
      <ShieldAlertIcon aria-hidden />
      <AlertTitle>{t("forbiddenTitle")}</AlertTitle>
      <AlertDescription>
        {detail ?? (permission ? t("needPermission", { permission }) : null)} {t("forbiddenHint")}
      </AlertDescription>
    </Alert>
  );
}
