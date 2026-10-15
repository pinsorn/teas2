import { InfoIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** 404 doc.type_not_available: the document type does not exist for this company (e.g. VAT-only for a non-VAT company). */
export function NotAvailableState({ reason }: { reason: 'vatOnly' | 'nonVatOnly' }) {
  const t = useTranslations("state");
  return (
    <Alert role="status" data-screen-state="not-available">
      <InfoIcon aria-hidden />
      <AlertTitle>{t("notAvailableTitle")}</AlertTitle>
      <AlertDescription>{t(`notAvailable.${reason}`)}</AlertDescription>
      <div className="col-start-2 mt-2"><Button asChild size="sm" variant="outline"><Link href="/">{t("notAvailableBack")}</Link></Button></div>
    </Alert>
  );
}
