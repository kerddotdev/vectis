import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/shell/app-shell";
import { WindowChromeProvider } from "@/shell/window-chrome";
import { StateProvider } from "@/state";
import { Connections } from "@/views/connections";
import { Environments } from "@/views/environments";
import { Diagnostics, Storage } from "@/views/machine";
import { Overview } from "@/views/overview";
import { Repositories } from "@/views/repositories";
import "./style.css";

const rootRoute = createRootRoute({ component: AppShell });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview }),
  createRoute({ getParentRoute: () => rootRoute, path: "/environments", component: Environments }),
  createRoute({ getParentRoute: () => rootRoute, path: "/repositories", component: Repositories }),
  createRoute({ getParentRoute: () => rootRoute, path: "/connections", component: Connections }),
  createRoute({ getParentRoute: () => rootRoute, path: "/storage", component: Storage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/diagnostics", component: Diagnostics }),
]);
const router = createRouter({ routeTree, history: createHashHistory() });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing desktop root.");
createRoot(root).render(
  <StrictMode>
    <StateProvider>
      <WindowChromeProvider>
        <TooltipProvider delay={300}>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </WindowChromeProvider>
    </StateProvider>
  </StrictMode>,
);
