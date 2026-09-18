import { osIcons, osNames } from "@vectis/design/os-icons";
import { cn } from "@/lib/utils";

export type GuestOS = keyof typeof osIcons;

export function OsIcon({ os, className }: { os: GuestOS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 fill-current", className)} aria-hidden>
      <path d={osIcons[os]} />
    </svg>
  );
}

export function OsTile({ os }: { os: GuestOS }) {
  return (
    <span
      className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/80"
      role="img"
      aria-label={osNames[os]}
    >
      <OsIcon os={os} className="size-[18px]" />
    </span>
  );
}
