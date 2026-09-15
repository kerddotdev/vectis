import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { startService } from "./http.js";

const home = process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
const program = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startService({
          home,
          onShutdown: () => process.emit("SIGTERM"),
          ...(process.env.VECTIS_APPLE_HELPER
            ? { appleHelper: process.env.VECTIS_APPLE_HELPER }
            : {}),
          ...(process.env.VECTIS_QEMU ? { qemu: process.env.VECTIS_QEMU } : {}),
          ...(process.env.VECTIS_QEMU_IMG ? { qemuImg: process.env.VECTIS_QEMU_IMG } : {}),
          ...(process.env.VECTIS_SWTPM ? { swtpm: process.env.VECTIS_SWTPM } : {}),
          ...(process.env.VECTIS_KEYCHAIN_HELPER
            ? { keychainHelper: process.env.VECTIS_KEYCHAIN_HELPER }
            : {}),
        }),
      ),
      (server) => Effect.promise(() => server.close()),
    );
    process.stdout.write(
      JSON.stringify({ event: "service.ready", url: server.connection.url, pid: process.pid }) +
        "\n",
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const stop = () => {
            process.off("SIGTERM", stop);
            process.off("SIGINT", stop);
            resolve();
          };
          process.once("SIGTERM", stop);
          process.once("SIGINT", stop);
        }),
    );
  }),
);
Effect.runPromise(program).catch(() => {
  process.stderr.write("Vectis service failed. Inspect configuration and the service lock.\n");
  process.exitCode = 1;
});
