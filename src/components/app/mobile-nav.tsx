"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

// Under laptop width the sidebar lives behind this button. Following a link closes the sheet.
export function MobileNav({
  homeHref = "/",
  help,
  children,
  alwaysShow = false,
  buttonLabel,
}: {
  homeHref?: string;
  help?: ReactNode;
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
          <Link href={homeHref} aria-label="Payday Copilot home" onClick={() => setOpen(false)} className="rounded-md">
            <Wordmark size="sm" />
          </Link>
        </div>
        <nav
          aria-label="Main"
          className="flex-1 overflow-y-auto px-3 py-2"
          onClick={(e) => {
            if ((e.target as Element).closest("a")) setOpen(false);
          }}
        >
          {children}
        </nav>
        {help ? <div className="border-t border-border px-5 py-4">{help}</div> : null}
      </Sheet>
    </>
  );
}
