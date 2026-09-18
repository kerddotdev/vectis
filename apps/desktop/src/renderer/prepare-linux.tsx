import { useState } from "react";
import { Schema } from "effect";
import { LinuxPreparation, MacInstallation } from "../../../../packages/protocol/src/index.js";
import { useStateApi } from "./state.js";

export function PrepareLinux() {
  const [os, setOs] = useState("linux");
  const [restorePath, setRestorePath] = useState("");
  const { submit, perform } = useStateApi();
  const [imageDirectory, setImageDirectory] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <section className="section">
      <h2>Prepare a guest image</h2>
      <p>
        {os === "linux"
          ? "Download verified Ubuntu 24.04 ARM64 and prepare SSH, Git, Docker and runner dependencies."
          : "Install a local Apple macOS 26 IPSW. Setup Assistant and guest SSH configuration are separate steps; this does not register a ready runner."}
        Other VMs must be stopped while preparing an image.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const fields = {
              id: data.get("id"),
              name: data.get("name"),
              imageDirectory,
              storagePath,
              cpu: Number(data.get("cpu")),
              memoryMiB: Number(data.get("memoryMiB")),
              diskGiB: Number(data.get("diskGiB")),
            };
            const command =
              os === "linux"
                ? {
                    type: "environment.prepare-linux" as const,
                    ...Schema.decodeUnknownSync(LinuxPreparation)(fields),
                  }
                : {
                    type: "environment.install-macos" as const,
                    ...Schema.decodeUnknownSync(MacInstallation)({ ...fields, restorePath }),
                  };
            setPending(true);
            setMessage("");
            void submit(command)
              .then((value) => {
                if (value !== undefined)
                  setMessage(
                    "Preparation requested. Follow progress, cancel or resume it in Overview.",
                  );
              })
              .finally(() => setPending(false));
          } catch {
            setMessage("Check the identifier, directories and resource values.");
          }
        }}
      >
        <label>
          Operating system
          <select value={os} disabled={pending} onChange={(event) => setOs(event.target.value)}>
            <option value="linux">Ubuntu 24.04 ARM64</option>
            <option value="macos">macOS 26 ARM64</option>
          </select>
        </label>
        {os === "macos" && (
          <label>
            Apple restore image (.ipsw)
            <input
              value={restorePath}
              onChange={(event) => setRestorePath(event.target.value)}
              required
            />
            <button
              type="button"
              onClick={() =>
                void perform("chooseRestoreImage").then((value) => {
                  if (typeof value === "string") setRestorePath(value);
                })
              }
            >
              Choose restore image
            </button>
          </label>
        )}
        <fieldset disabled={pending} key={os}>
          <label>
            Environment ID
            <input
              name="id"
              defaultValue={os === "linux" ? "ubuntu-24-arm64" : "macos-26-arm64"}
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}"
            />
          </label>
          <label>
            Name
            <input
              name="name"
              defaultValue={os === "linux" ? "Ubuntu 24.04 ARM64" : "macOS 26 ARM64"}
              required
            />
          </label>
          <label>
            Base image directory
            <input
              value={imageDirectory}
              onChange={(event) => setImageDirectory(event.target.value)}
              required
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void perform("chooseDirectory").then((value) => {
                if (typeof value === "string") setImageDirectory(value);
              })
            }
          >
            Choose image folder
          </button>
          <label>
            Disposable VM directory
            <input
              value={storagePath}
              onChange={(event) => setStoragePath(event.target.value)}
              required
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void perform("chooseDirectory").then((value) => {
                if (typeof value === "string") setStoragePath(value);
              })
            }
          >
            Choose VM folder
          </button>
          <label>
            CPU cores
            <input name="cpu" type="number" min="1" defaultValue="2" required />
          </label>
          <label>
            Memory (MiB)
            <input
              name="memoryMiB"
              type="number"
              min={os === "linux" ? "2048" : "4096"}
              step="512"
              defaultValue="4096"
              required
            />
          </label>
          <label>
            Virtual disk capacity (GiB)
            <input
              name="diskGiB"
              type="number"
              min={os === "linux" ? "16" : "40"}
              max="2048"
              defaultValue={os === "linux" ? "32" : "64"}
              required
            />
          </label>
          <button type="submit">
            {os === "linux" ? "Prepare Linux environment" : "Install macOS"}
          </button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
