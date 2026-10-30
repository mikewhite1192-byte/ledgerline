"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

// Under laptop width the sidebar lives behind this button. Following a link closes the sheet.
// `top` sits above the menu (the carrier and the area tabs) and `bottom` under the help link (who
// is signed in, the light and dark switch, sign out); the whole sheet scrolls as one.
export function MobileNav({
  homeHref = "/",
  help,
  top,
  bottom,
  children,
  alwaysShow = false,
  buttonLabel,
}: {
  homeHref?: string;
  help?: ReactNode;
  top?: ReactNode;
  bottom?: ReactNode;
  children: ReactNode;
  // /design opens it at any width, with a visible label.
  alwaysShow?: boolean;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={buttonLabel ? "outline" : "ghost"}
        size={buttonLabel ? "md" : "icon"}
        aria-label={buttonLabel ? undefined : "Open menu"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(!alwaysShow && "-ml-2 lg:hidden")}
      >
        <Menu aria-hidden />
        {buttonLabel}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Menu">
        <div className="flex h-14 shrink-0 items-center px-5">
          <Link href={homeHref} aria-label="LedgerLine home" onClick={() => setOpen(false)} className="rounded-md">
            <Wordmark size="sm" />
          </Link>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          onClick={(e) => {
            if ((e.target as Element).closest("a")) setOpen(false);
          }}
        >
          {top ? <div className="grid gap-3 px-3 pb-2">{top}</div> : null}
          <nav aria-label="Main" className="flex-1 px-3 py-2">
            {children}
          </nav>
          {help ? <div className="border-t border-border px-5 py-4">{help}</div> : null}
          {bottom ? <div className="grid gap-3 px-5 pb-4">{bottom}</div> : null}
        </div>
      </Sheet>
    </>
  );
}
