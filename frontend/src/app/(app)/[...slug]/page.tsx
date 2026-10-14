import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ComingInSp1c } from "@/app-shell/ComingInSp1c";
import { matchNavItem } from "@/app-shell/nav";

async function resolve(params: PageProps<"/[...slug]">["params"]) {
  const path = `/${(await params).slug.join("/")}`;
  const hit = matchNavItem(path);
  if (!hit || hit.item.href === "/") notFound();
  return { path, label: (await getTranslations())(hit.item.labelKey) };
}

export async function generateMetadata({ params }: PageProps<"/[...slug]">): Promise<Metadata> {
  return { title: (await resolve(params)).label };
}

export default async function SlugPage({ params }: PageProps<"/[...slug]">) {
  const { path, label } = await resolve(params);
  return <ComingInSp1c title={label} href={path} />;
}
