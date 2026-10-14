import { VectisError } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";

export async function verifyQemuIsolation(executable: string, signal?: AbortSignal) {
  const version = await runProcess(executable, ["-vectis-isolation-version"], signal).catch(
    () => "",
  );
  signal?.throwIfAborted();
  if (version.trim() !== "1")
    throw new VectisError(
      "setup_required",
      "Windows guests require the isolated Vectis QEMU runtime.",
      "Build QEMU with both Vectis patches and configure VECTIS_QEMU with that runtime.",
    );
}
