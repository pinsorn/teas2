import { Anuphan, IBM_Plex_Sans_Thai, JetBrains_Mono, Noto_Sans_Thai } from "next/font/google";

// Fonts for the three directions only; loaded on /style-tiles. Sarabun (paper) comes from the root layout.
const a = IBM_Plex_Sans_Thai({ variable: "--tile-font-a", subsets: ["thai", "latin"], weight: ["400", "500", "600", "700"] });
const b = Noto_Sans_Thai({ variable: "--tile-font-b", subsets: ["thai", "latin"] });
const c = Anuphan({ variable: "--tile-font-c", subsets: ["thai", "latin"] });
const cMono = JetBrains_Mono({ variable: "--tile-mono-c", subsets: ["latin"] });

export const tileFontClass = [a, b, c, cMono].map((f) => f.variable).join(" ");
