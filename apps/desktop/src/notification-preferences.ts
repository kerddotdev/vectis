import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

const Preferences = Schema.Struct({ notificationsEnabled: Schema.Boolean });

export class NotificationPreferences {
  private pending = Promise.resolve();

  private constructor(
    private readonly directory: string,
    private enabled: boolean,
  ) {}

  static async open(directory: string) {
    let enabled = true;
    try {
      const value: unknown = JSON.parse(
        await readFile(join(directory, "desktop-preferences.json"), "utf8"),
      );
      enabled = Schema.decodeUnknownSync(Preferences)(value).notificationsEnabled;
    } catch {
      // Missing or unreadable preferences must not prevent the app from starting.
    }
    return new NotificationPreferences(directory, enabled);
  }

  get() {
    return this.enabled;
  }

  set(enabled: boolean) {
    const saved = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `desktop-preferences-${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify({ notificationsEnabled: enabled }) + "\n", {
          mode: 0o600,
        });
        await rename(temporary, join(this.directory, "desktop-preferences.json"));
        this.enabled = enabled;
      } finally {
        await rm(temporary, { force: true });
      }
      return enabled;
    });
    this.pending = saved.then(
      () => undefined,
      () => undefined,
    );
    return saved;
  }
}
