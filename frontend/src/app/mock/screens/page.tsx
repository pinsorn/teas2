import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { NAV } from "@/app-shell/nav";
import { descriptorByPath } from "@/descriptors";
import { recordByPath } from "@/records";
import { fixtureIds } from "@/mocks/fixtures/ids";
import { buildSeedState } from "@/mocks/store";
import { SCREENS, TI_BASE, type Screen } from "./screens";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("screens"))("title"), robots: { index: false } };
}

const STATES = ["normal", "empty", "loading", "error", "forbidden", "locked"] as const;
const ROLES = ["operator", "accountant", "admin"] as const;

// Plain anchors on purpose: the mock layer reads the query once on a full page load (MockProvider).
const href = (route: string, q: { state?: string; role?: string; company: string }) => {
  const p = new URLSearchParams({ state: q.state ?? "normal", ...(q.role ? { role: q.role } : {}), company: q.company });
  return `${route}${route.includes('?') ? '&' : '?'}${p}`;
};
const link = "text-brand underline underline-offset-2";

export default async function ScreenIndexPage() {
  const t = await getTranslations("screens");
  const tn = await getTranslations();
  const ids = fixtureIds(buildSeedState()); // server-side, accountant seed
  const resolve = (r: Screen["route"]) => typeof r === "string" ? r : `${r.base ?? TI_BASE}/${ids[r.fixture]}${r.suffix ?? ""}`;
  const built = SCREENS.map((s) => ({ ...s, path: resolve(s.route) }));
  // pending = a nav entry with no descriptor, no screen-index entry (record descriptors join here when they exist)
  const pending = NAV.flatMap((g) => g.items).filter((i) => !descriptorByPath(i.href) && !recordByPath(i.href) && !SCREENS.some((s) => s.route === i.href));
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4 md:p-6">
      <header>
        <h1 className="text-title font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>

      <section aria-labelledby="built" className="space-y-3">
        <h2 id="built" className="text-section font-semibold">{t("built")}</h2>
        <ul className="space-y-3">
          {built.map((s) => (
            <li key={s.name} className="space-y-2 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{t(`name.${s.name}`)}</h3>
                <span className="text-small text-muted-foreground">{t("vat")}: {t(s.company === "vat" ? "vatOnly" : s.company === "nonvat" ? "nonVatOnly" : "vatBoth")}</span>
              </div>
              <p className="text-small text-muted-foreground">{t("route")}: <code className="tabular-nums">{s.path}</code></p>
              <p>
                <a className={link} href={href(s.path, { role: "accountant", company: s.company === "nonvat" ? "nonvat" : "vat" })}>{t("open")} {t(`name.${s.name}`)}</a>
              </p>
              {s.states && (
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-small">
                  <span className="text-muted-foreground">{t("states")}:</span>
                  {STATES.map((st) => <a key={st} className={link} href={href(s.path, { state: st, role: "accountant", company: "vat" })}>{t(`state.${st}`)}</a>)}
                </p>
              )}
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-small">
                <span className="text-muted-foreground">{t("roles")}:</span>
                {ROLES.map((r) => <a key={r} className={link} href={href(s.path, { role: r, company: "vat" })}>{t(`role.${r}`)}</a>)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pending" className="space-y-3">
        <h2 id="pending" className="text-section font-semibold">{t("pending")}</h2>
        <p className="text-small text-muted-foreground">{t("pendingLead")}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {pending.map((i) => (
            <li key={i.key} className="rounded-md border bg-card px-3 py-2 text-small">
              <a className={link} href={href(i.href, { role: "accountant", company: i.nonVatOnly ? "nonvat" : "vat" })}>{tn(i.labelKey)}</a>
              <span className="text-muted-foreground"> · <code>{i.href}</code> · {t("pending")} · {t("vat")}: {t(i.vatOnly ? "vatOnly" : i.nonVatOnly ? "nonVatOnly" : "vatBoth")}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
