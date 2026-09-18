import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { VectisError } from "../../protocol/src/index.js";
import { runProcess } from "../../runner/src/process.js";
import { localClient } from "./local.js";

const runtimeKeys = [
  "VECTIS_APPLE_HELPER",
  "VECTIS_QEMU",
  "VECTIS_QEMU_IMG",
  "VECTIS_SWTPM",
  "VECTIS_KEYCHAIN_HELPER",
] as const;
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export class LaunchAgent {
  private constructor(
    readonly home: string,
    readonly label: string,
    readonly path: string,
    private readonly domain: string,
    private readonly execute: typeof runProcess,
  ) {}

  static async forHome(
    home: string,
    options: { directory?: string; execute?: typeof runProcess } = {},
  ) {
    if (platform() !== "darwin" || !process.getuid || process.getuid() === 0)
      throw new VectisError("unsupported_host", "Login services require a non-root macOS user.");
    const absolute = resolve(home);
    const canonical = await canonicalPath(absolute);
    const label = `dev.kerd.vectis.${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
    return new LaunchAgent(
      canonical,
      label,
      join(options.directory ?? join(homedir(), "Library", "LaunchAgents"), `${label}.plist`),
      `gui/${process.getuid()}`,
      options.execute ?? runProcess,
    );
  }

  async installed() {
    try {
      const source = await readFile(this.path, "utf8");
      if (
        !source.includes(`<key>Label</key><string>${this.label}</string>`) ||
        !source.includes(`<key>VECTIS_HOME</key><string>${escapeXml(this.home)}</string>`)
      )
        throw new VectisError(
          "installation_conflict",
          "The login service definition is not owned by this Vectis home.",
        );
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async loaded() {
    try {
      await this.execute("/bin/launchctl", ["print", `${this.domain}/${this.label}`]);
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    const installed = await this.installed();
    return {
      installed,
      loaded: installed && (await this.loaded()),
      home: this.home,
      path: this.path,
    };
  }

  async install(environment: NodeJS.ProcessEnv = process.env, nodeExecutable = process.execPath) {
    if (!isAbsolute(nodeExecutable))
      throw new VectisError("invalid_runtime_path", "Node must use an absolute executable path.");
    await access(nodeExecutable, constants.X_OK);
    if (await this.installed()) return this.start();
    const existing = await localClient(this.home)
      .then((api) => api.status())
      .catch(() => undefined);
    if (existing)
      throw new VectisError(
        "service_running",
        "Stop the manually started service before installing a login service.",
        "Run vectis service stop with the same --home, then retry installation.",
      );
    const entry = fileURLToPath(new URL("../../../apps/server/src/main.js", import.meta.url));
    await access(entry, constants.R_OK);
    const variables: Record<string, string> = { VECTIS_HOME: this.home };
    for (const key of runtimeKeys) {
      const value = environment[key];
      if (!value) continue;
      if (!isAbsolute(value))
        throw new VectisError(
          "invalid_runtime_path",
          `${key} must be an absolute executable path.`,
        );
      await access(value, constants.X_OK);
      variables[key] = value;
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${this.label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(nodeExecutable)}</string><string>${escapeXml(entry)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(variables)
      .map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`)
      .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escapeXml(join(this.home, "service.log"))}</string>
<key>StandardErrorPath</key><string>${escapeXml(join(this.home, "service.log"))}</string>
</dict></plist>
`;
    await mkdir(resolve(this.path, ".."), { recursive: true, mode: 0o700 });
    const file = await open(this.path, "wx", 0o600);
    try {
      await file.writeFile(xml);
    } finally {
      await file.close();
    }
    return this.start();
  }

  async start() {
    if (!(await this.installed()))
      throw new VectisError(
        "service_not_installed",
        "No login service is installed for this home.",
        "Run vectis service install.",
      );
    try {
      if (!(await this.loaded()))
        await this.execute("/bin/launchctl", ["bootstrap", this.domain, this.path]);
      await this.execute("/bin/launchctl", ["kickstart", `${this.domain}/${this.label}`]);
    } catch {
      throw new VectisError(
        "launch_agent_unavailable",
        "macOS did not start the login service.",
        "Check background item permissions in System Settings and service.log, then retry service start.",
      );
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        await (await localClient(this.home)).status(AbortSignal.timeout(1000));
        return { installed: true, running: true, home: this.home, path: this.path };
      } catch {
        await delay(100);
      }
    }
    throw new VectisError(
      "startup_timeout",
      "The login service was registered but readiness was not observed.",
      "Inspect service.log and run service start again. The installation can be retried or uninstalled.",
    );
  }

  async uninstall() {
    if (!(await this.installed())) return { installed: false, home: this.home };
    const running = await localClient(this.home)
      .then((api) => api.status())
      .catch(() => undefined);
    if (running)
      throw new VectisError(
        "service_running",
        "Stop the service before removing its login registration.",
        "Run vectis service stop with the same --home; it stops owned VMs. Then retry service uninstall.",
      );
    if (await this.loaded())
      await this.execute("/bin/launchctl", ["bootout", `${this.domain}/${this.label}`]);
    await rm(this.path);
    return { installed: false, home: this.home };
  }
}
