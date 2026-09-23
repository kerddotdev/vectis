export const toolbarHeight = 46;
export const trafficLightPosition = { x: 16, y: 16 };
export const routes = [
  "/",
  "/activities",
  "/environments",
  "/repositories",
  "/connections",
  "/storage",
  "/diagnostics",
  "/settings",
] as const;
export type Route = (typeof routes)[number];
export type WindowEvent =
  | "fullscreen-enter"
  | "fullscreen-leave"
  | "toggle-sidebar"
  | `navigate:${Route}`;
