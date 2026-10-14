import { getTranslations } from "next-intl/server";
import { Sidebar } from "@/app-shell/Sidebar";
import { Topbar } from "@/app-shell/Topbar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const t = await getTranslations("shell");
  return (
    <div className="flex min-h-dvh">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        {t("skipToContent")}
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="content" className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
