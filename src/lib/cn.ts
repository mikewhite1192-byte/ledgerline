import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge has to know the app's own type scale and shadow names, or it reads `text-body`
// as a color and drops it when a color class follows.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "small", "body", "lead", "h3", "h2", "h1", "figure"],
      shadow: ["float"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
