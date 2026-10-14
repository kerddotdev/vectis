import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NotificationPreferences } from "./notification-preferences.js";

const directories: string[] = [];
async function userData() {
  const directory = await mkdtemp(join(tmpdir(), "vectis-notifications-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("notifications default to on and the preference survives reopening", async () => {
  const directory = await userData();
  const preferences = await NotificationPreferences.open(directory);
  expect(preferences.get()).toBe(true);
  expect(await preferences.set(false)).toBe(false);
  expect(preferences.get()).toBe(false);
  expect((await NotificationPreferences.open(directory)).get()).toBe(false);
  await preferences.set(true);
  expect((await NotificationPreferences.open(directory)).get()).toBe(true);
  expect(await readdir(directory)).toEqual(["desktop-preferences.json"]);
});

test.each(["invalid json", '{"notificationsEnabled":"false"}'])(
  "invalid preferences use the default: %s",
  async (content) => {
    const directory = await userData();
    await writeFile(join(directory, "desktop-preferences.json"), content);
    expect((await NotificationPreferences.open(directory)).get()).toBe(true);
  },
);

test("concurrent writes retain the last requested preference", async () => {
  const directory = await userData();
  const preferences = await NotificationPreferences.open(directory);
  await Promise.all([preferences.set(false), preferences.set(true), preferences.set(false)]);
  expect(preferences.get()).toBe(false);
  expect((await NotificationPreferences.open(directory)).get()).toBe(false);
  expect(await readdir(directory)).toEqual(["desktop-preferences.json"]);
});

test("a failed save preserves the active preference and allows a retry", async () => {
  const directory = await userData();
  const preferences = await NotificationPreferences.open(directory);
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  await expect(preferences.set(false)).rejects.toThrow();
  expect(preferences.get()).toBe(true);
  await rm(directory);
  await preferences.set(false);
  expect(preferences.get()).toBe(false);
});
