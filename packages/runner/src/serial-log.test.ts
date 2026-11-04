import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSerialLog,
  pruneSerialLogs,
  readSerialTail,
  serialLogLimit,
  serialLogPath,
} from "./serial-log.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

afterEach(() => vi.restoreAllMocks());

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function segments(home: string, id: string) {
  const path = serialLogPath(home, id);
  return Promise.all(
    [`${path}.1`, path].map(async (segment) => {
      try {
        return await readFile(segment);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return Buffer.alloc(0);
        throw error;
      }
    }),
  );
}

test("append-only rotation bounds both segments and retains the newest bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
  try {
    const log = await createSerialLog(home, "flood");
    const stream = new PassThrough();
    log.attach(stream);
    const input: Buffer[] = [];
    for (let index = 0; index < 40; index++) {
      const chunk = Buffer.alloc(70001, index);
      input.push(chunk);
      stream.write(chunk);
      await tick();
      const sizes = await Promise.all(
        [serialLogPath(home, "flood"), `${serialLogPath(home, "flood")}.1`].map(
          async (path) => (await stat(path).catch(() => undefined))?.size ?? 0,
        ),
      );
      expect(Math.max(...sizes)).toBeLessThanOrEqual(serialLogLimit / 2);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(serialLogLimit);
    }
    stream.end();
    await log.close();
    const retained = Buffer.concat(await segments(home, "flood"));
    expect(retained.length).toBeGreaterThanOrEqual(serialLogLimit / 2);
    expect(retained.length).toBeLessThanOrEqual(serialLogLimit);
    expect(retained).toEqual(Buffer.concat(input).subarray(-retained.length));
    expect(await readSerialTail(home, "flood")).toBe(retained.subarray(-8192).toString("utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("small batches append without rewriting previously recorded bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
  try {
    const log = await createSerialLog(home, "append");
    const file = await vi.mocked(open).mock.results.at(-1)?.value;
    if (!file) throw new Error("Missing log handle");
    const write = vi.spyOn(file, "write");
    const stream = new PassThrough();
    log.attach(stream);
    stream.write("first");
    await vi.waitFor(() => expect(log.pendingBytes).toBe(0));
    await vi.waitFor(async () =>
      expect(await readFile(serialLogPath(home, "append"), "utf8")).toBe("first"),
    );
    stream.end("second");
    await log.close();
    expect(write.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 5, null],
      [0, 6, null],
    ]);
    expect(await readFile(serialLogPath(home, "append"), "utf8")).toBe("firstsecond");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "a stalled write drains with bounded pending memory (failure: %s)",
  async (fail) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const log = await createSerialLog(home, "slow");
      const file = await vi.mocked(open).mock.results.at(-1)?.value;
      if (!file) throw new Error("Missing log handle");
      const originalWrite = file.write.bind(file);
      const write = vi.spyOn(file, "write").mockImplementationOnce(async () => {
        await blocked;
        if (fail) throw new Error("Disk unavailable");
        return originalWrite(Buffer.from("x"), 0, 1, null);
      });
      const stream = new PassThrough();
      let drained = 0;
      stream.on("data", (chunk: Buffer) => {
        drained += chunk.length;
      });
      log.attach(stream);
      stream.write("x");
      const chunk = Buffer.alloc(256 * 1024, "a");
      for (let index = 0; index < 100; index++) {
        stream.write(chunk);
        expect(log.pendingBytes).toBeLessThanOrEqual(serialLogLimit);
      }
      stream.write(Buffer.alloc(serialLogLimit * 2, "z"));
      stream.write("newest");
      expect(drained).toBe(1 + chunk.length * 100 + serialLogLimit * 2 + 6);
      expect(log.pendingBytes).toBe(serialLogLimit);
      expect(log.droppedBytes).toBe(chunk.length * 100 + serialLogLimit + 6);
      expect(write).toHaveBeenCalledTimes(1);
      release();
      await log.close();
      expect(log.pendingBytes).toBe(0);
      if (fail) {
        expect(write).toHaveBeenCalledTimes(1);
        stream.write("still draining");
        expect(drained).toBe(1 + chunk.length * 100 + serialLogLimit * 2 + 6 + 14);
        expect(log.pendingBytes).toBe(0);
        expect(Buffer.concat(await segments(home, "slow"))).toHaveLength(0);
      } else {
        const retained = Buffer.concat(await segments(home, "slow"));
        expect(retained.length).toBeLessThanOrEqual(serialLogLimit);
        expect(retained).toEqual(
          Buffer.concat([Buffer.alloc(retained.length - 6, "z"), Buffer.from("newest")]),
        );
      }
      stream.end();
    } finally {
      release();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("retention keeps the newest 50 instances as units and ignores foreign files", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
  try {
    await (await createSerialLog(home, "0")).close();
    const directory = join(home, "diagnostics", "serial");
    const foreign = [
      "notes.txt",
      "bad.id.log",
      "bad id.log",
      "a.log.2",
      ".log",
      "a.log.1.bak",
      "bad.log\n",
    ];
    for (const name of foreign) await writeFile(join(directory, name), "keep");
    const link = serialLogPath(home, "link");
    await symlink(join(directory, "notes.txt"), link);
    for (let index = 0; index < 55; index++) {
      const path = serialLogPath(home, String(index));
      await writeFile(path, String(index));
      await writeFile(`${path}.1`, "older segment");
      await utimes(path, index + 1, index + 1);
      await utimes(`${path}.1`, index + 1, index + 1);
    }
    // The newest segment determines age even when the current segment is older.
    await utimes(`${serialLogPath(home, "0")}.1`, 100, 100);
    await pruneSerialLogs(home);
    expect(await readdir(directory)).toHaveLength(100 + foreign.length + 1);
    for (const name of foreign) expect(await readFile(join(directory, name), "utf8")).toBe("keep");
    expect(await readFile(link, "utf8")).toBe("keep");
    for (let index = 1; index <= 5; index++) {
      for (const path of [
        serialLogPath(home, String(index)),
        `${serialLogPath(home, String(index))}.1`,
      ]) {
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    for (const index of [0, ...Array.from({ length: 49 }, (_, i) => i + 6)]) {
      const path = serialLogPath(home, String(index));
      expect(await readFile(path, "utf8")).toBe(String(index));
      expect(await readFile(`${path}.1`, "utf8")).toBe("older segment");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the newest 8 KiB tail spans both segments", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
  try {
    await (await createSerialLog(home, "tail")).close();
    const path = serialLogPath(home, "tail");
    await writeFile(
      `${path}.1`,
      Buffer.concat([Buffer.alloc(9000, "a"), Buffer.from([0xe2, 0x82])]),
    );
    await writeFile(path, Buffer.concat([Buffer.from([0xac]), Buffer.alloc(999, "b")]));
    expect(await readSerialTail(home, "tail")).toBe(`${"a".repeat(7190)}€${"b".repeat(999)}`);
    await rm(path);
    expect(await readSerialTail(home, "tail")).toBe(`${"a".repeat(8190)}�`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("instance names are used directly and unsafe names are rejected", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-serial-"));
  try {
    const id = "Instance-09_Az";
    expect(serialLogPath(home, id)).toBe(join(home, "diagnostics", "serial", `${id}.log`));
    await (await createSerialLog(home, id)).close();
    for (const unsafe of ["", "../escape", "a/b", "a\\b", "a.b", "a b", "árvíz", "a\n"]) {
      expect(() => serialLogPath(home, unsafe)).toThrow("Invalid serial log instance id");
      await expect(createSerialLog(home, unsafe)).rejects.toThrow("Invalid serial log instance id");
      await expect(readSerialTail(home, unsafe)).rejects.toThrow("Invalid serial log instance id");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
