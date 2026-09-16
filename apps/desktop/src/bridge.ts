export type DesktopAction =
  | "status"
  | "storage"
  | "doctor"
  | "repositories"
  | "github.accounts"
  | "jobs"
  | "command"
  | "service.install"
  | "service.stop"
  | "chooseDirectory"
  | "chooseRestoreImage"
  | "cloud.pair"
  | "cloud.finish"
  | "open.pull"
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
