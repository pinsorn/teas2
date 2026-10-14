import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// text-title/section/body/small are font sizes (globals.css @theme); without this twMerge reads them as colours and drops them.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["title", "section", "body", "small"] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
