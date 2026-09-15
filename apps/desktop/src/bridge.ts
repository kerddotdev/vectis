export type DesktopAction =
  | "status"
  | "storage"
  | "doctor"
  | "command"
  | "service.install"
  | "service.stop"
  | "chooseDirectory"
  | "cloud.pair"
  | "cloud.finish"
  | "open.docs"
  | "open.github";
export type DesktopReply =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; nextStep: string } };
declare global {
  interface Window {
    vectis: { request(action: DesktopAction, input?: unknown): Promise<DesktopReply> };
  }
}
