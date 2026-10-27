import localFont from "next/font/local";

// Public Sans, the one typeface (SIL Open Font License 1.1, see fonts/OFL.txt): the variable
// latin subset, upright, weights 100 to 900, served by this app so no build and no page load
// fetches a font. It carries tnum (tabular figures), which every money column relies on.
// Source: https://fonts.gstatic.com/s/publicsans/v21/ijwRs572Xtc6ZYQws9YVwnNGfJ7QwOk1.woff2
// sha256: c1b6da516e0062e9c2f341b3a51dd2d621d946da72f06c6cfe05fd9d2dd8622d (26,636 bytes)
export const sans = localFont({
  src: "./fonts/public-sans-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-public-sans",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
  adjustFontFallback: "Arial",
});
