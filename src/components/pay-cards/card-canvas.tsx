"use client";

import { useEffect, useRef } from "react";
import { artPath, isPayCardArt } from "@/lib/pay-cards/art";
import type { CardSpec } from "@/lib/pay-cards/spec";
import { drawPayCard, type DrawArt } from "./draw";

// The pay card in the browser: a small preview on the cards page, and the full-size picture the
// check reads. Both are drawn by drawPayCard from the server's CardSpec text, in the page's own
// font once it has loaded.

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const artCache = new Map<string, Promise<DrawArt>>();

// The card's background picture, loaded once per page. A picture that does not load draws the
// plain background instead: the words and figures are the same either way.
function loadArt(spec: CardSpec): Promise<DrawArt> {
  if (!isPayCardArt(spec.art)) return Promise.resolve(null);
  const src = artPath(spec.art);
  let pending = artCache.get(src);
  if (!pending) {
    pending = new Promise<DrawArt>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = src;
    });
    artCache.set(src, pending);
  }
  return pending;
}

async function pageFont(): Promise<string> {
  try {
    await document.fonts.ready;
  } catch {
    // Drawn in the fallback font; the check reads whatever is drawn.
  }
  return getComputedStyle(document.body).fontFamily || "sans-serif";
}

// The full-size card as a PNG file, ready for the check, at most maxBytes when it can be.
export async function cardPng(spec: CardSpec, maxBytes: number): Promise<Blob> {
  const [art, font] = await Promise.all([loadArt(spec), pageFont()]);
  return fitPng((a) => drawPng(spec, a, font), art, maxBytes);
}

// A picture that takes the file past the check's size cap is dropped: the card is drawn again on
// the plain background, with the same words and figures. The server still checks the size.
export async function fitPng(draw: (art: DrawArt) => Promise<Blob>, art: DrawArt, maxBytes: number): Promise<Blob> {
  const first = await draw(art);
  if (art === null || first.size <= maxBytes) return first;
  return draw(null);
}

function drawPng(spec: CardSpec, art: DrawArt, font: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no drawing surface"));
  drawPayCard(ctx, spec.text, art, font);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no picture"))), "image/png");
  });
}

// The file as base64, for the check's JSON body.
export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

// A small preview of the card, drawn at a fifth of its size.
export function CardPreview({ spec, label }: { spec: CardSpec; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([loadArt(spec), pageFont()]).then(([art, font]) => {
      const canvas = ref.current;
      const ctx = canvas?.getContext("2d");
      if (!live || !canvas || !ctx) return;
      const scale = canvas.width / CARD_WIDTH;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawPayCard(ctx, spec.text, art, font);
    });
    return () => {
      live = false;
    };
  }, [spec]);
  return (
    <canvas
      ref={ref}
      width={216}
      height={270}
      role="img"
      aria-label={label}
      className="h-auto w-[108px] shrink-0 rounded-md border border-border sm:w-[144px]"
    />
  );
}
