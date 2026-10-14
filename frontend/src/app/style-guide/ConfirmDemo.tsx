"use client";

import { useTranslations } from "next-intl";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";

/** Anatomy: title = verb + object; consequence line; the totals being committed; back (secondary) + the verb button (primary). */
export function ConfirmDemo() {
  const t = useTranslations("styleGuide");
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button>{t("confirmOpen")}</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
          <dt className="text-muted-foreground">{t("confirmNet")}</dt><dd className="text-right tabular-nums">{formatMoney("60000")}</dd>
          <dt className="text-muted-foreground">{t("confirmVat")}</dt><dd className="text-right tabular-nums">{formatMoney("4200")}</dd>
          <dt className="border-t border-foreground pt-1 font-semibold">{t("confirmTotal")}</dt>
          <dd className="border-t border-foreground pt-1 text-right font-semibold tabular-nums">฿{formatMoney("64200")}</dd>
        </dl>
        <p className="text-small text-muted-foreground">{t("confirmWords")}</p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
          <AlertDialogAction>{t("confirmAction")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
