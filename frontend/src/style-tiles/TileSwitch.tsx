"use client";
import { useEffect } from "react";

/** Mirrors the URL hash (#a | #b | #c) into <html data-tile-active>; tiles.css shows only the active tile. Nothing shows before hydration. */
export function TileSwitch() {
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => {
      const h = location.hash.slice(1);
      el.setAttribute("data-tile-active", /^[abc]$/.test(h) ? h : "a");
    };
    sync();
    addEventListener("hashchange", sync);
    return () => { removeEventListener("hashchange", sync); el.removeAttribute("data-tile-active"); };
  }, []);
  return null;
}
