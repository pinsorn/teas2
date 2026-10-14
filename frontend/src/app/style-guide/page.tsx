import type { Metadata } from "next";
import { LockIcon, PlusIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DocStatus } from "@/domain/types";
import { StatusChip } from "@/kit/doc-list/StatusChip";
import { formatDateBE, formatMoney } from "@/lib/format";
import { ConfirmDemo } from "./ConfirmDemo";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("styleGuide"))("title"), robots: { index: false } };
}

const STATUSES: DocStatus[] = ["draft", "pending", "approved", "issued", "partly_settled", "settled", "cancelled", "replaced"];
const SWATCHES: [string, string][] = [
  ["bg", "--color-bg"], ["surface", "--color-surface"], ["ink", "--color-ink"], ["inkMuted", "--color-ink-muted"],
  ["rule", "--color-rule"], ["controlBorder", "--color-control-border"], ["brand", "--color-brand"], ["brandSoft", "--color-brand-soft"],
  ["brandInk", "--color-brand-ink"], ["danger", "--color-danger"],
];
const ROWS: [string, number, string, DocStatus | "overdue", string][] = [
  ["TI-202610-0042", 0, "2026-10-14", "issued", "64200"],
  ["TI-202610-0041", 1, "2026-10-09", "partly_settled", "18725.5"],
  ["TI-202610-0040", 2, "2026-09-30", "overdue", "5350"],
  ["TI-202610-0039", 3, "2026-09-22", "settled", "120000"],
  ["", 4, "2026-10-14", "draft", "9800"],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="text-section font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const panel = "rounded-xl border bg-card p-5 shadow-(--shadow-panel)";

export default async function StyleGuidePage() {
  const t = await getTranslations("styleGuide");
  const tc = await getTranslations("common");
  return (
    <main className="mx-auto max-w-5xl space-y-10 p-6 pb-16">
      <header>
        <h1 className="text-title font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>

      <Section id="colors" title={t("colors")}>
        <p className="text-small text-muted-foreground">{t("colorNote")}</p>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SWATCHES.map(([k, v]) => (
            <li key={k} className="space-y-1">
              <div aria-hidden className="h-10 rounded-md border" style={{ background: `var(${v})` }} />
              <p className="text-small leading-tight">{t(`swatch.${k}`)}</p>
              <p className="text-small leading-tight text-muted-foreground tabular-nums">{v}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="type" title={t("type")}>
        <div className={`${panel} space-y-2`}>
          <p className="text-title font-semibold">{t("sampleTitle")}</p>
          <p className="text-section font-semibold">{t("sampleSection")}</p>
          <p className="text-body">{t("sampleBody")}</p>
          <p className="text-small text-muted-foreground">{t("sampleSmall")}</p>
          <p className="text-body tabular-nums">{t("numbers")}</p>
        </div>
      </Section>

      <Section id="buttons" title={t("buttons")}>
        <div className={`${panel} flex flex-wrap items-start gap-3`}>
          <Button><PlusIcon aria-hidden />{t("primary")}</Button>
          <Button variant="secondary">{t("secondary")}</Button>
          <Button variant="outline">{t("outline")}</Button>
          <Button variant="ghost">{t("ghost")}</Button>
          <Button variant="destructive">{t("destructive")}</Button>
          <Button size="sm" variant="outline">{t("small")}</Button>
          <Button size="icon" variant="outline" aria-label={t("icon")}><PlusIcon aria-hidden /></Button>
          <div className="flex flex-col gap-1">
            <Button disabled aria-describedby="why-disabled">{t("disabled")}</Button>
            <p id="why-disabled" className="text-small text-muted-foreground">{t("disabledWhy")}</p>
          </div>
        </div>
      </Section>

      <Section id="inputs" title={t("inputs")}>
        <div className={`${panel} grid gap-4 sm:grid-cols-3`}>
          <div className="space-y-1.5"><Label htmlFor="sg-name">{t("label")}</Label><Input id="sg-name" placeholder={t("placeholder")} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="sg-tin">{t("labelError")}</Label>
            <Input id="sg-tin" defaultValue="123456" aria-invalid aria-describedby="sg-tin-err" />
            <p id="sg-tin-err" className="text-small text-destructive">{t("errorText")}</p>
          </div>
          <div className="space-y-1.5"><Label htmlFor="sg-no">{t("labelDisabled")}</Label><Input id="sg-no" disabled defaultValue="TI-202610-0042" /></div>
        </div>
      </Section>

      <Section id="chips" title={t("chips")}>
        <ul className="flex flex-wrap gap-2">
          {STATUSES.map((s) => <li key={s}><StatusChip status={s} /></li>)}
          <li><StatusChip status="overdue" /></li>
        </ul>
      </Section>

      <Section id="states" title={t("states")}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className={panel} role="status">
            <span className="sr-only">{t("loadingT")}</span>
            <Skeleton className="mb-2 h-(--row-h)" /><Skeleton className="mb-2 h-(--row-h)" /><Skeleton className="h-(--row-h)" />
          </div>
          <div className={`${panel} flex flex-col items-start gap-2`}>
            <p className="text-section font-semibold">{t("emptyT")}</p>
            <p className="text-muted-foreground">{t("emptyBody")}</p>
            <Button><PlusIcon aria-hidden />{t("emptyAction")}</Button>
          </div>
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>{t("errorT")}</AlertTitle>
            <AlertDescription className="text-foreground!">
              {t("errorBody")} <span className="text-muted-foreground tabular-nums">{t("trace", { id: "a1b2c3d4" })}</span>
            </AlertDescription>
            <AlertAction><Button size="sm" variant="outline">{t("retry")}</Button></AlertAction>
          </Alert>
          <Alert role="status">
            <ShieldAlertIcon aria-hidden />
            <AlertTitle>{t("forbiddenT")}</AlertTitle>
            <AlertDescription>{t("forbiddenBody")}</AlertDescription>
          </Alert>
          <Alert role="status" className="border-(--color-status-pending-fg)/40 bg-(--color-status-pending-bg) text-(--color-status-pending-fg) md:col-span-2">
            <LockIcon aria-hidden />
            <AlertTitle>{t("lockedT")}</AlertTitle>
            <AlertDescription className="text-(--color-status-pending-fg)!">{t("lockedBody")}</AlertDescription>
            <div className="col-start-2 mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline">{t("lockedExit1")}</Button>
              <Button size="sm" variant="outline">{t("lockedExit2")}</Button>
            </div>
          </Alert>
        </div>
      </Section>

      <Section id="table" title={t("table")}>
        <div className={`${panel} overflow-hidden p-0`}>
          <Table>
            <caption className="sr-only">{t("table")}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{t("colNo")}</TableHead><TableHead scope="col">{t("colParty")}</TableHead>
                <TableHead scope="col">{t("colDate")}</TableHead><TableHead scope="col">{t("colStatus")}</TableHead>
                <TableHead scope="col" className="text-right">{t("colTotal")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map(([no, party, date, st, total]) => (
                <TableRow key={party}>
                  <TableCell className="tabular-nums">{no || tc("draftNoNumber")}</TableCell>
                  <TableCell>{t(`party${party}`)}</TableCell>
                  <TableCell className="tabular-nums">{formatDateBE(date)}</TableCell>
                  <TableCell><StatusChip status={st} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section id="confirm" title={t("confirm")}>
        <ConfirmDemo />
      </Section>
    </main>
  );
}
