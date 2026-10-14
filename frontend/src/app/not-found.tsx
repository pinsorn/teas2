import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-3 p-6">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <Button variant="outline" asChild><Link href="/">{t("back")}</Link></Button>
    </main>
  );
}
