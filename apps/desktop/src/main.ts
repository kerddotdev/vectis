import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import electronUpdater from "electron-updater";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";
import { Request, VectisError } from "../../../packages/protocol/src/index.js";
import { localClient } from "../../../packages/client/src/local.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import {
  beginPairing,
  disconnectPairing,
  finishPairing,
} from "../../../packages/client/src/pairing.js";
import { githubConnection } from "../../../packages/client/src/github.js";
import { controllerClient } from "../../../packages/client/src/controller.js";
import {
  beginControllerLogin,
  finishControllerLogin,
  logoutController,
} from "../../../packages/client/src/controller-login.js";
import { RemoteClient } from "../../../packages/client/src/remote.js";
import { buildInfo } from "../../../packages/client/src/build.js";
import { cloudDeployment, resolveHome } from "../../../packages/client/src/deployment.js";
import { desktopTarget } from "./target.js";
import { commandLineStatus, installCommandLine, shellPath } from "./command-line.js";
import { UpdateController, type UpdateService } from "./updates.js";
import { trafficLightPosition, type Route, type WindowEvent } from "./chrome.js";
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
const production = buildInfo().flavor === "production";
app.setName(production ? "Vectis" : "Vectis Dev");
app.setAboutPanelOptions({
  applicationName: production ? "Vectis" : "Vectis Dev",
  applicationVersion: app.isPackaged ? app.getVersion() : "Development",
  copyright: "kerd.dev · https://kerd.dev",
  website: "https://vectis.kerd.dev",
});
const home = resolveHome();
const page = fileURLToPath(
  new URL("../../../../apps/desktop/renderer/index.html", import.meta.url),
);
const pageUrl = pathToFileURL(page).href;
const restartMarker = join(home, "restart-after-update");
const updateService: UpdateService = {
  async stopIfIdle() {
    const client = await localClient(home);
    try {
      await client.status();
    } catch {
      return "not-running";
    }
    try {
      await client.shutdown({ ifIdle: true });
    } catch (error) {
      if (error instanceof VectisError && error.code === "service_busy") return "busy";
      throw error;
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((done) => setTimeout(done, 500));
      try {
        await client.status();
      } catch {
        return "stopped";
      }
    }
    throw new VectisError(
      "update_blocked",
      "The service did not stop, so the update was not installed.",
      "Stop the service from Overview, then install the update again.",
    );
  },
  async rememberRestart() {
    await writeFile(restartMarker, "", { mode: 0o600 });
  },
};
const updates =
  app.isPackaged && production && existsSync(join(process.resourcesPath, "app-update.yml"))
    ? (() => {
        const { autoUpdater } = electronUpdater;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.allowPrerelease = false;
        autoUpdater.disableDifferentialDownload = true;
        return new UpdateController(
          {
            check: async () => {
              await autoUpdater.checkForUpdates();
            },
            quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
            subscribe: (listener) => {
              autoUpdater.on("checking-for-update", () => listener({ type: "checking" }));
              autoUpdater.on("update-available", (info) =>
                listener({ type: "available", version: info.version }),
              );
              autoUpdater.on("update-not-available", () => listener({ type: "none" }));
              autoUpdater.on("download-progress", (progress) =>
                listener({ type: "progress", percent: progress.percent }),
              );
              autoUpdater.on("update-downloaded", (info) =>
                listener({ type: "downloaded", version: info.version }),
              );
              autoUpdater.on("error", (error) => listener({ type: "error", error }));
            },
          },
          updateService,
          { checkIntervalMs: 4 * 60 * 60 * 1000, retryIdleMs: 30000 },
        );
      })()
    : undefined;
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
                cloudDeployment(),
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
            case "logs":
              data = await (await client()).logs();
              break;
            case "command":
            case "command.settle": {
              const request = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(
                input,
              );
              const target = await client();
              data =
                action === "command.settle"
                  ? await target.settle(request.command, request.key)
                  : await target.submit(request.command, request.key);
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
            case "cloud.finish":
            case "cloud.disconnect": {
              const helper = process.env.VECTIS_KEYCHAIN_HELPER;
              if (!helper)
                throw new VectisError(
                  "runtime_missing",
                  "The Keychain helper is required for pairing.",
                );
              const credentials = new KeychainCredentials(helper);
              if (action === "cloud.pair") {
                const pairing = await beginPairing(home, cloudDeployment(), credentials);
                await shell.openExternal(pairing.url);
                data = { state: pairing.state, verificationCode: pairing.verificationCode };
              } else if (action === "cloud.finish") data = await finishPairing(home, credentials);
              else data = await disconnectPairing(home, credentials);
              break;
            }
            case "open.url":
              // Only a GitHub page, and only one the service reported: a job link is data that
              // came from the cloud, not something the window may open freely.
              if (
                typeof input !== "string" ||
                !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9/_.-]*$/.test(
                  input,
                )
              )
                throw new VectisError("invalid_url", "Expected a GitHub URL.");
              await shell.openExternal(input);
              data = null;
              break;
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
            case "cli.status":
            case "cli.install": {
              if (!app.isPackaged)
                throw new VectisError(
                  "unsupported_in_development",
                  "Command line tools install from the packaged app.",
                  "From a source checkout, run pnpm vectis and pnpm mcp.",
                );
              if (action === "cli.install") await installCommandLine(process.resourcesPath);
              data = await commandLineStatus(process.resourcesPath, undefined, await shellPath());
              break;
            }
            case "update.status":
              data = updates?.current() ?? { status: "disabled" };
              break;
            case "update.check":
              data = (await updates?.check()) ?? { status: "disabled" };
              break;
            case "update.install":
              data = (await updates?.install()) ?? { status: "disabled" };
              break;
            case "open.docs":
              await shell.openExternal("https://vectis.kerd.dev/docs");
              data = null;
              break;
            case "open.github":
              await shell.openExternal(githubConnection(cloudDeployment()).url);
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
    const destinations: ReadonlyArray<{ label: string; route: Route }> = [
      { label: "Overview", route: "/" },
      { label: "Activity", route: "/activities" },
      { label: "Environments", route: "/environments" },
      { label: "Repositories", route: "/repositories" },
      { label: "Connections", route: "/connections" },
      { label: "Storage", route: "/storage" },
      { label: "Diagnostics", route: "/diagnostics" },
    ];
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Vectis",
          submenu: [
            { label: "About Vectis", role: "about" },
            { type: "separator" },
            {
              label: "Settings...",
              accelerator: "CmdOrCtrl+,",
              click: () => send("navigate:/settings"),
            },
            { type: "separator" },
            { label: "Hide Vectis", role: "hide" },
            { label: "Hide Others", role: "hideOthers" },
            { label: "Show All", role: "unhide" },
            { type: "separator" },
            { label: "Quit Vectis", role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { label: "Undo", role: "undo" },
            { label: "Redo", role: "redo" },
            { type: "separator" },
            { label: "Cut", role: "cut" },
            { label: "Copy", role: "copy" },
            { label: "Paste", role: "paste" },
            { label: "Select All", role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            {
              label: "Toggle Sidebar",
              accelerator: "CmdOrCtrl+B",
              click: () => send("toggle-sidebar"),
            },
            { type: "separator" },
            { label: "Toggle Full Screen", role: "togglefullscreen" },
            ...(app.isPackaged
              ? []
              : [
                  { type: "separator" as const },
                  { label: "Reload", role: "reload" as const },
                  { label: "Toggle Developer Tools", role: "toggleDevTools" as const },
                ]),
          ],
        },
        {
          label: "Go",
          submenu: destinations.map(({ label, route }, index) => ({
            label,
            accelerator: `CmdOrCtrl+${index + 1}`,
            click: () => send(`navigate:${route}`),
          })),
        },
        {
          label: "Window",
          submenu: [
            { label: "Minimize", role: "minimize" },
            { label: "Zoom", role: "zoom" },
            { type: "separator" },
            { label: "Bring All to Front", role: "front" },
          ],
        },
        {
          label: "Help",
          submenu: [
            {
              label: "Vectis Documentation",
              click: () => void shell.openExternal("https://vectis.kerd.dev/docs"),
            },
            {
              label: "Report an Issue",
              click: () => void shell.openExternal("https://github.com/kerddotdev/vectis/issues"),
            },
          ],
        },
      ]),
    );
    function open() {
      window = new BrowserWindow({
        width: 1280,
        height: 820,
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
          devTools: !app.isPackaged,
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
    updates?.start(15000);
    if (existsSync(restartMarker))
      void rm(restartMarker)
        .then(() => LaunchAgent.forHome(home))
        .then(async (agent) => {
          if (await agent.installed()) await agent.start();
        })
        .catch(() => undefined);
    app.on("activate", () => {
      if (!window) open();
    });
    app.on("window-all-closed", () => app.quit());
  });
}
