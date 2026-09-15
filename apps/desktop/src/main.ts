import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";
import { Request, VectisError } from "../../../packages/protocol/src/index.js";
import { localClient } from "../../../packages/client/src/local.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { beginPairing, finishPairing } from "../../../packages/client/src/pairing.js";
import type { DesktopReply } from "./bridge.js";
const home = process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
const page = fileURLToPath(
  new URL("../../../../apps/desktop/renderer/index.html", import.meta.url),
);
const pageUrl = pathToFileURL(page).href;
let window: BrowserWindow | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle(
      "vectis:request",
      async (event, action: unknown, input: unknown): Promise<DesktopReply> => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url.split("#")[0] !== pageUrl
        )
          return {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Untrusted desktop request.",
              nextStep: "Restart Vectis.",
            },
          };
        try {
          let data: unknown;
          switch (action) {
            case "status":
              data = await (await localClient(home)).status();
              break;
            case "storage":
              data = await (await localClient(home)).storage();
              break;
            case "command": {
              const request = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(
                input,
              );
              data = await (await localClient(home)).submit(request.command, request.key);
              break;
            }
            case "service.install": {
              const node = process.env.VECTIS_NODE_EXECUTABLE;
              if (!node)
                throw new VectisError(
                  "runtime_missing",
                  "A standalone Node runtime is required.",
                  "Start the development desktop through pnpm desktop:start.",
                );
              const directory = process.env.VECTIS_LAUNCH_AGENTS_DIR;
              data = await (
                await LaunchAgent.forHome(home, directory ? { directory } : {})
              ).install(process.env, node);
              break;
            }
            case "service.stop":
              data = await (await localClient(home)).shutdown();
              break;
            case "chooseDirectory": {
              const result = await dialog.showOpenDialog(window, {
                properties: ["openDirectory", "createDirectory"],
              });
              data = result.canceled ? null : (result.filePaths[0] ?? null);
              break;
            }
            case "cloud.pair":
            case "cloud.finish": {
              const helper = process.env.VECTIS_KEYCHAIN_HELPER;
              if (!helper)
                throw new VectisError(
                  "runtime_missing",
                  "The Keychain helper is required for pairing.",
                );
              const credentials = new KeychainCredentials(helper);
              data =
                action === "cloud.pair"
                  ? await beginPairing(home, "https://clear-hare-471.convex.cloud", credentials)
                  : await finishPairing(home, credentials);
              break;
            }
            case "open.docs":
              await shell.openExternal("https://vectis.kerd.dev/docs/");
              data = null;
              break;
            case "open.github":
              await shell.openExternal("https://vectis.kerd.dev/connect?github=1");
              data = null;
              break;
            default:
              throw new VectisError("unsupported_command", "Unsupported desktop action.");
          }
          return { ok: true, data };
        } catch (error) {
          const issue =
            error instanceof VectisError
              ? error
              : new VectisError("request_failed", "The desktop request could not be completed.");
          return {
            ok: false,
            error: { code: issue.code, message: issue.message, nextStep: issue.nextStep },
          };
        }
      },
    );
    function open() {
      window = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 800,
        minHeight: 580,
        backgroundColor: "#15191e",
        title: "Vectis",
        webPreferences: {
          preload: fileURLToPath(new URL("../../../../apps/desktop/preload.cjs", import.meta.url)),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("closed", () => {
        window = undefined;
      });
      void window.loadFile(page);
    }
    open();
    app.on("activate", () => {
      if (!window) open();
    });
    app.on("window-all-closed", () => app.quit());
  });
}
