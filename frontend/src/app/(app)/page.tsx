import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HomeView } from "./home-view";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("home"))("title") };
}

export default function HomePage() {
  return <HomeView />;
}
