import { useEffect } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { SidebarToggle } from "@/components/layout";
import { cn } from "@/lib/utils";
import { useStateApi } from "@/state";
import { Sidebar, useSidebarWidth } from "./sidebar";
import { useWindowChrome } from "./window-chrome";

export function AppShell() {
  const { collapsed, fullscreen } = useWindowChrome();
  const { machineId, dismissError } = useStateApi();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => dismissError(), [pathname]);
  useEffect(
    () =>
      window.vectis?.onWindowEvent((event) => {
        if (event.startsWith("navigate:")) void navigate({ to: event.slice("navigate:".length) });
      }),
    [],
  );
  const { width, resizing, handle } = useSidebarWidth();
  return (
    <div className="relative flex h-full">
      <div
        className={cn(
          "relative shrink-0 overflow-hidden",
          !resizing && "transition-[width] duration-300 ease-drawer",
        )}
        style={{ width: collapsed ? 0 : width }}
        inert={collapsed}
      >
        <div className="h-full" style={{ width }}>
          <Sidebar />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize"
          {...handle}
        />
      </div>
      <main className="min-w-0 flex-1 bg-background shadow-[inset_0.5px_0_0_var(--vectis-hairline-strong)]">
        <Outlet key={machineId ?? "local"} />
      </main>
      <div
        className={cn(
          "absolute top-[9px] z-30 [-webkit-app-region:no-drag]",
          fullscreen ? "left-3" : "left-[84px]",
        )}
      >
        <SidebarToggle />
      </div>
    </div>
  );
}
