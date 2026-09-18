import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  PanelLeftIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useWindowChrome } from "@/shell/window-chrome";
import { useStateApi } from "@/state";

export function SidebarToggle() {
  const { toggleSidebar, collapsed } = useWindowChrome();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      aria-keyshortcuts="Meta+B"
      onClick={toggleSidebar}
    >
      <PanelLeftIcon />
    </Button>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { collapsed, fullscreen } = useWindowChrome();
  const { error, snapshot, ready, machineId, perform } = useStateApi();
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    if (!heading.current || !scroller.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCondensed(entry ? !entry.isIntersecting : false),
      { root: scroller.current, rootMargin: "-8px 0px 0px 0px" },
    );
    observer.observe(heading.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="view-enter flex h-full min-w-0 flex-col">
      <header
        className={cn(
          "drag-region flex h-[46px] shrink-0 items-center gap-2 border-b pr-3 transition-colors duration-150",
          condensed ? "border-border" : "border-transparent",
          collapsed ? (fullscreen ? "pl-14" : "pl-[124px]") : "pl-4",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "truncate text-sm font-semibold transition-opacity duration-150",
            condensed ? "opacity-100" : "opacity-0",
          )}
        >
          {title}
        </span>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto max-w-[1120px] px-8 pt-4 pb-20">
          <h1
            ref={heading}
            className="font-heading text-[26px] leading-tight font-medium tracking-[-0.02em]"
          >
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-[62ch] text-muted-foreground">{description}</p>
          )}
          {ready && !snapshot && !machineId && (
            <Notice
              tone="attention"
              className="mt-5"
              title="The Vectis service is not running"
              action={
                <Button size="sm" onClick={() => void perform("service.install")}>
                  Install and start service
                </Button>
              }
            >
              The service runs your virtual machines independently of this window and keeps running
              after you close it.
            </Notice>
          )}
          {ready && !snapshot && machineId && (
            <Notice tone="attention" className="mt-5" title="Waiting for the remote machine">
              Check that the Vectis service is online on that machine.
            </Notice>
          )}
          {error && (
            <Notice tone="danger" className="mt-5" role="alert">
              {error}
            </Notice>
          )}
          <div className="mt-8 flex flex-col gap-10">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Section({
  title,
  description,
  hint,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-h-7 items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            {title}
            {hint}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-[62ch] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function List({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-2xl bg-card ring-1 ring-border">
      {children}
    </div>
  );
}

export function Row({
  title,
  detail,
  leading,
  trailing,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rise-in px-4 py-3">
      <div className="flex items-center gap-3">
        {leading}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
        </div>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
      {children && <div className="mt-3 flex flex-col gap-3 empty:hidden">{children}</div>}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cn("font-mono text-[12px] break-all text-muted-foreground", className)}>
      {children}
    </code>
  );
}

const noticeTones = {
  info: { icon: InfoIcon, className: "bg-muted", iconClassName: "text-muted-foreground" },
  attention: {
    icon: TriangleAlertIcon,
    className: "bg-attention/8 ring-1 ring-inset ring-attention/20",
    iconClassName: "text-attention",
  },
  danger: {
    icon: TriangleAlertIcon,
    className: "bg-danger/8 ring-1 ring-inset ring-danger/20",
    iconClassName: "text-danger",
  },
  success: {
    icon: CircleCheckIcon,
    className: "bg-success/8 ring-1 ring-inset ring-success/20",
    iconClassName: "text-success",
  },
} as const;

export function Notice({
  tone = "info",
  title,
  action,
  className,
  role = "status",
  children,
}: {
  tone?: keyof typeof noticeTones;
  title?: string;
  action?: ReactNode;
  className?: string;
  role?: "status" | "alert";
  children?: ReactNode;
}) {
  const { icon: Icon, className: toneClassName, iconClassName } = noticeTones[tone];
  return (
    <div role={role} className={cn("flex gap-3 rounded-2xl px-4 py-3", toneClassName, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClassName)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && (
          <div className="text-muted-foreground" data-selectable>
            {children}
          </div>
        )}
        {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl px-4 py-6 text-center text-muted-foreground ring-1 ring-border ring-inset">
      {children}
    </p>
  );
}

export function ExpandableRow({
  leading,
  title,
  summary,
  aside,
  actions,
  defaultOpen = false,
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rise-in">
      <div className="flex items-center gap-2 pr-3">
        <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset">
          <ChevronRightIcon
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/trigger:rotate-90"
            aria-hidden
          />
          {leading}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{title}</span>
            {summary && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground group-data-panel-open/trigger:hidden">
                {summary}
              </span>
            )}
          </span>
          {aside && <span className="flex shrink-0 items-center gap-3">{aside}</span>}
        </CollapsibleTrigger>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <CollapsibleContent className="data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-1">
        <div className="flex flex-col gap-4 pr-4 pb-4 pl-[46px]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Details({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  const visible = items.filter(
    ([, value]) => value !== undefined && value !== null && value !== false && value !== "",
  );
  if (!visible.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-6 gap-y-1.5 text-xs">
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words" data-selectable>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "attention" | "success" | "running" | undefined;
}) {
  return (
    <div className="rise-in flex min-w-0 flex-col gap-1 rounded-2xl bg-card px-4 py-3.5 ring-1 ring-border">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-heading text-[22px] leading-tight font-medium tracking-[-0.01em] tabular-nums",
          tone === "attention" && "text-attention",
          tone === "success" && "text-success",
          tone === "running" && "text-running",
        )}
      >
        {value}
      </p>
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function usePages<T>(items: readonly T[], size: number) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  return {
    items: items.slice(current * size, current * size + size),
    pager:
      items.length > size ? (
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {current * size + 1}-{Math.min(items.length, (current + 1) * size)} of {items.length}
          </span>
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </span>
        </div>
      ) : null,
    reset: () => setPage(0),
  };
}
