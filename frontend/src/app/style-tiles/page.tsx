import type { Metadata } from "next";
import { tileFontClass } from "@/style-tiles/fonts";
import { buildSample } from "@/style-tiles/sample";
import { TILES } from "@/style-tiles/tokens";
import { TileSwitch } from "@/style-tiles/TileSwitch";
import { TileSurfaces } from "@/style-tiles/TileSurfaces";
import "@/style-tiles/tiles.css";
import "@/style-tiles/tokens-a.css";
import "@/style-tiles/tokens-b.css";
import "@/style-tiles/tokens-c.css";

export const metadata: Metadata = { title: "SP1a style tiles", robots: { index: false } };

// Design artefact for the visual-direction pick (SP1a). Tabs are plain #a/#b/#c links; TileSwitch mirrors the hash into <html data-tile-active>.
export default function StyleTilesPage() {
  const sample = buildSample();
  return (
    <div className={`tiles-root ${tileFontClass}`} lang="th">
      <TileSwitch />
      <header className="tiles-switch sticky top-0 z-10 flex flex-wrap items-center gap-3 bg-white px-6 py-3 shadow-sm" style={{ color: "#1a1a1a" }}>
        <h1 className="mr-2 text-base font-semibold">SP1a ทิศทางภาพ</h1>
        <nav aria-label="เลือกทิศทาง" className="flex gap-2">
          {TILES.map((t) => (
            <a key={t.id} href={`#${t.id}`} className="rounded-md px-4 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
              {t.title.split(" (")[0]}
            </a>
          ))}
        </nav>
      </header>
      {TILES.map((t) => <TileSurfaces key={t.id} t={t} s={sample} />)}
    </div>
  );
}
