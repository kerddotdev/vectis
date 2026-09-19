import type { WindowEvent } from "./chrome.js";
export type DesktopAction =
  | "controller.login"
  | "controller.finish"
  | "controller.logout"
  | "machines.list"
  | "status"
  | "storage"
  | "doctor"
  | "logs"
  | "repositories"
  | "github.accounts"
  | "jobs"
  | "command"
  | "service.install"
  | "service.update"
  | "service.recover-update"
  | "service.uninstall"
  | "service.stop"
  | "service.stop-idle"
  | "chooseDirectory"
  | "chooseRestoreImage"
  | "chooseFile"
  | "cloud.pair"
  | "cloud.finish"
  | "cloud.disconnect"
  | "open.pull"
  | "open.docs"
  | "open.github"
  | "cli.status"
  | "cli.install"
  | "update.status"
  | "update.check"
  | "update.install";
export type DesktopReply =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; nextStep: string } };
declare global {
  interface Window {
    vectis: {
      request(action: DesktopAction, input?: unknown, machineId?: string): Promise<DesktopReply>;
      onWindowEvent(listener: (event: WindowEvent) => void): () => void;
    };
  }
}
