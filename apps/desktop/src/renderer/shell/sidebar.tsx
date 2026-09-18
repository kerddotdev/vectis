import { useRef, useState, type PointerEvent } from "react";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  BookOpenIcon,
  FolderGit2Icon,
  HardDriveIcon,
  LayoutGridIcon,
  MonitorIcon,
  PlugIcon,
  type LucideIcon,
} from "lucide-react";
import { useStateApi } from "@/state";
import { MachineSwitcher } from "./machine-switcher";

const widthKey = "vectis.sidebar-width";
const defaultWidth = 232;
const clamp = (value: number) => Math.min(320, Math.max(200, value));

const primary = [
  { to: "/", label: "Overview", icon: LayoutGridIcon },
  { to: "/environments", label: "Environments", icon: MonitorIcon },
  { to: "/repositories", label: "Repositories", icon: FolderGit2Icon },
  { to: "/connections", label: "Connections", icon: PlugIcon },
] as const;
const machine = [
  { to: "/storage", label: "Storage", icon: HardDriveIcon },
  { to: "/diagnostics", label: "Diagnostics", icon: ActivityIcon },
] as const;

export function useSidebarWidth() {
  const [width, setWidth] = useState(() =>
    clamp(Number(localStorage.getItem(widthKey)) || defaultWidth),
  );
  const start = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  return {
    width,
    resizing,
    handle: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        setResizing(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (start.current) setWidth(clamp(start.current.width + event.clientX - start.current.x));
      },
      onPointerUp() {
        start.current = null;
        setResizing(false);
        localStorage.setItem(widthKey, String(width));
      },
      onDoubleClick() {
        setWidth(defaultWidth);
        localStorage.setItem(widthKey, String(defaultWidth));
      },
    },
  };
}

function NavLink({
  to,
  label,
  icon: Icon,
  count,
}: {
  to: (typeof primary | typeof machine)[number]["to"];
  label: string;
  icon: LucideIcon;
  count?: number | undefined;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      className="group flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 data-[status=active]:bg-sidebar-accent"
    >
      <Icon
        className="size-4 text-muted-foreground group-data-[status=active]:text-brand"
        aria-hidden
      />
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>
      )}
    </Link>
  );
}

export function Sidebar() {
  const { snapshot, perform } = useStateApi();
  const active = snapshot?.operations.filter((operation) =>
    ["accepted", "running", "action_required"].includes(operation.status),
  ).length;
  return (
    <aside className="flex h-full min-w-0 flex-col" aria-label="Sidebar">
      <div className="drag-region h-[46px] shrink-0" />
      <nav aria-label="Main navigation" className="flex flex-col gap-0.5 px-2.5 pt-1.5">
        {primary.map((item) => (
          <NavLink
            key={item.to}
            {...item}
            count={
              item.to === "/"
                ? active
                : item.to === "/environments"
                  ? snapshot?.environments.length
                  : undefined
            }
          />
        ))}
        <p className="px-2.5 pt-5 pb-1.5 text-xs font-semibold text-muted-foreground">Machine</p>
        {machine.map((item) => (
          <NavLink key={item.to} {...item} />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1 p-2.5">
        <button
          type="button"
          onClick={() => void perform("open.docs")}
          className="flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <BookOpenIcon className="size-4" aria-hidden />
          Documentation
        </button>
        <MachineSwitcher />
      </div>
    </aside>
  );
}
