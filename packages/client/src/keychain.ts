import { spawn } from "node:child_process";
import { VectisError } from "../../protocol/src/index.js";

export class KeychainCredentials {
  constructor(readonly helper: string) {}
  private async run(action: "get" | "set" | "delete", account: string, input?: string) {
    if (
      !account ||
      account.length > 500 ||
      (input !== undefined && (!input || Buffer.byteLength(input) > 4096))
    )
      throw new VectisError("invalid_credential", "Credential account or value is invalid.");
    const child = spawn(this.helper, [action, account], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    child.once("error", () => {
      failed = true;
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = (output + chunk).slice(0, 4097);
      if (output.length > 4096) {
        failed = true;
        child.kill("SIGTERM");
      }
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const deadline = setTimeout(() => {
      failed = true;
      child.kill("SIGTERM");
      force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000);
    }, 15000);
    child.stdin.end(input);
    try {
      await closed;
    } finally {
      clearTimeout(deadline);
      clearTimeout(force);
    }
    if (!failed && child.exitCode === 44 && action === "get") return null;
    if (failed || child.exitCode !== 0)
      throw new VectisError(
        "credential_store_unavailable",
        "The platform credential store is unavailable.",
        "Unlock the login keychain and verify the configured Vectis Keychain helper.",
      );
    return output;
  }
  get(account: string) {
    return this.run("get", account);
  }
  async set(account: string, secret: string) {
    await this.run("set", account, secret);
  }
  async remove(account: string) {
    await this.run("delete", account);
  }
}
