import type { Metadata } from "next";
import { Noto_Sans_Thai, Sarabun } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/lib/query/QueryProvider";
import { MockProvider } from "@/mocks/MockProvider";
import { MockToolbarGate } from "@/mocks/MockToolbar";
import "./globals.css";

// UI font (direction B, SP1a). Variable font: all weights.
const uiFont = Noto_Sans_Thai({
  variable: "--font-ui",
  subsets: ["thai", "latin"],
});

// Paper font for printed documents (screen = paper).
const paperFont = Sarabun({
  variable: "--font-paper",
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  const name = (await getTranslations("app"))("name");
  return { title: { default: name, template: `%s · ${name}` }, description: name };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${uiFont.variable} ${paperFont.variable} h-full antialiased`}>
      <body className="min-h-full">
        <NextIntlClientProvider>
          <QueryProvider>
            <MockProvider>
              {children}
              <MockToolbarGate />
            </MockProvider>
            <Toaster />
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
