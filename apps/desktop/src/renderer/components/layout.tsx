import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheckIcon, InfoIcon, PanelLeftIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
          collapsed && !fullscreen ? "pl-[84px]" : "pl-4",
        )}
      >
        {collapsed && <SidebarToggle />}
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
        <div className="mx-auto max-w-[880px] px-8 pt-4 pb-20">
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
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
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
