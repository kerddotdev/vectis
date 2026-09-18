import { existsSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";
import { Request, VectisError } from "../../../packages/protocol/src/index.js";
import { localClient } from "../../../packages/client/src/local.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { beginPairing, finishPairing } from "../../../packages/client/src/pairing.js";
import { controllerClient } from "../../../packages/client/src/controller.js";
import {
  beginControllerLogin,
  finishControllerLogin,
  logoutController,
} from "../../../packages/client/src/controller-login.js";
import { RemoteClient } from "../../../packages/client/src/remote.js";
import { desktopTarget } from "./target.js";
import { trafficLightPosition, type WindowEvent } from "./chrome.js";
import type { DesktopReply } from "./bridge.js";
if (app.isPackaged) {
  const runtime = join(process.resourcesPath, "runtime");
  process.env.VECTIS_NODE_EXECUTABLE ??= join(runtime, "bin", "node");
  process.env.VECTIS_APPLE_HELPER ??= join(runtime, "vectis-vm");
  process.env.VECTIS_KEYCHAIN_HELPER ??= join(runtime, "vectis-keychain");
  for (const [variable, executable] of [
    ["VECTIS_QEMU", "qemu-system-aarch64"],
    ["VECTIS_QEMU_IMG", "qemu-img"],
    ["VECTIS_SWTPM", "swtpm"],
  ] as const) {
    const binary = join(runtime, "windows", "bin", executable);
    if (existsSync(binary)) process.env[variable] ??= binary;
  }
}
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
      async (event, action: unknown, input: unknown, target: unknown): Promise<DesktopReply> => {
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
          const machineId = desktopTarget(action, target);
          function credentials() {
            const helper = process.env.VECTIS_KEYCHAIN_HELPER;
            if (!helper)
              throw new VectisError("runtime_missing", "The Keychain helper is required.");
            return new KeychainCredentials(helper);
          }
          async function client() {
            return machineId
              ? new RemoteClient(await controllerClient(home, credentials()), machineId)
              : localClient(home);
          }
          let data: unknown;
          switch (action) {
            case "machines.list":
              data = await (
                await controllerClient(home, credentials())
              ).request({ type: "machines.list" });
              break;
            case "controller.login": {
              const login = await beginControllerLogin(
                home,
                "https://clear-hare-471.convex.cloud",
                "Vectis desktop",
                credentials(),
              );
              await shell.openExternal(login.url);
              data = { state: login.state, verificationCode: login.verificationCode };
              break;
            }
            case "controller.finish":
              data = await finishControllerLogin(home, credentials());
              break;
            case "controller.logout":
              data = await logoutController(home, credentials());
              break;
            case "status":
              data = await (await client()).status();
              break;
            case "jobs": {
              const bindingId = Schema.decodeUnknownSync(Schema.NonEmptyString)(input);
              data = await (await client()).jobs(bindingId);
              break;
            }
            case "github.accounts":
              data = await (await client()).githubAccounts();
              break;
            case "repositories":
              data = await (await client()).repositories();
              break;
            case "doctor":
              data = await (await client()).doctor();
              break;
            case "storage":
              data = await (await client()).storage();
              break;
            case "command": {
              const request = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(
                input,
              );
              data = await (await client()).submit(request.command, request.key);
              break;
            }
            case "service.install":
            case "service.update": {
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
              )[action === "service.update" ? "update" : "install"](process.env, node);
              break;
            }
            case "service.recover-update":
            case "service.uninstall": {
              const directory = process.env.VECTIS_LAUNCH_AGENTS_DIR;
              const agent = await LaunchAgent.forHome(home, directory ? { directory } : {});
              data = await agent[action === "service.uninstall" ? "uninstall" : "recoverUpdate"]();
              break;
            }
            case "service.stop":
              data = await (await client()).shutdown();
              break;
            case "service.stop-idle":
              data = await (await client()).shutdown({ ifIdle: true });
              break;
            case "chooseFile": {
              const result = await dialog.showOpenDialog(window, { properties: ["openFile"] });
              data = result.canceled ? null : (result.filePaths[0] ?? null);
              break;
            }
            case "chooseRestoreImage": {
              const result = await dialog.showOpenDialog(window, {
                properties: ["openFile"],
                filters: [{ name: "Apple restore image", extensions: ["ipsw"] }],
              });
              data = result.canceled ? null : (result.filePaths[0] ?? null);
              break;
            }
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
              if (action === "cloud.pair") {
                const pairing = await beginPairing(
                  home,
                  "https://clear-hare-471.convex.cloud",
                  credentials,
                );
                await shell.openExternal(pairing.url);
                data = { state: pairing.state, verificationCode: pairing.verificationCode };
              } else data = await finishPairing(home, credentials);
              break;
            }
            case "open.pull":
              if (
                typeof input !== "string" ||
                !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
                  input,
                )
              )
                throw new VectisError("invalid_pull_url", "Expected a GitHub pull request URL.");
              await shell.openExternal(input);
              data = null;
              break;
            case "open.docs":
              await shell.openExternal("https://vectis.kerd.dev/docs");
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
    function send(event: WindowEvent) {
      window?.webContents.send("vectis:window", event);
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            {
              label: "Toggle Sidebar",
              accelerator: "CmdOrCtrl+B",
              click: () => send("toggle-sidebar"),
            },
            { type: "separator" },
            { role: "togglefullscreen" },
            ...(app.isPackaged
              ? []
              : [
                  { type: "separator" as const },
                  { role: "reload" as const },
                  { role: "toggleDevTools" as const },
                ]),
          ],
        },
        { role: "windowMenu" },
        {
          role: "help",
          submenu: [
            {
              label: "Vectis Documentation",
              click: () => void shell.openExternal("https://vectis.kerd.dev/docs"),
            },
          ],
        },
      ]),
    );
    function open() {
      window = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 800,
        minHeight: 580,
        show: false,
        title: "Vectis",
        titleBarStyle: "hiddenInset",
        trafficLightPosition,
        vibrancy: "sidebar",
        visualEffectState: "followWindow",
        backgroundColor: "#00000000",
        webPreferences: {
          preload: fileURLToPath(new URL("../../../../apps/desktop/preload.cjs", import.meta.url)),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window.once("ready-to-show", () => window?.show());
      window.on("enter-full-screen", () => send("fullscreen-enter"));
      window.on("leave-full-screen", () => send("fullscreen-leave"));
      window.webContents.on("did-finish-load", () => {
        void window?.webContents.setVisualZoomLevelLimits(1, 1);
        if (window?.isFullScreen()) send("fullscreen-enter");
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
