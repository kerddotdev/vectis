import { useState } from "react";
import { Schema } from "effect";
import { LinuxPreparation } from "../../../../packages/protocol/src/index.js";
import { useStateApi } from "./state.js";

export function PrepareLinux() {
  const { submit, perform } = useStateApi();
  const [imageDirectory, setImageDirectory] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <section className="section">
      <h2>Prepare Ubuntu 24.04 ARM64</h2>
      <p>
        Download the verified base image and prepare guest SSH, Git, Docker and runner dependencies.
        Other VMs must be stopped while preparing an image.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const input = Schema.decodeUnknownSync(LinuxPreparation)({
              id: data.get("id"),
              name: data.get("name"),
              imageDirectory,
              storagePath,
              cpu: Number(data.get("cpu")),
              memoryMiB: Number(data.get("memoryMiB")),
              diskGiB: Number(data.get("diskGiB")),
            });
            setPending(true);
            setMessage("");
            void submit({ type: "environment.prepare-linux", ...input })
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
        <fieldset disabled={pending}>
          <label>
            Environment ID
            <input
              name="id"
              defaultValue="ubuntu-24-arm64"
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}"
            />
          </label>
          <label>
            Name
            <input name="name" defaultValue="Ubuntu 24.04 ARM64" required />
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
              min="2048"
              step="512"
              defaultValue="4096"
              required
            />
          </label>
          <label>
            Virtual disk capacity (GiB)
            <input name="diskGiB" type="number" min="16" max="2048" defaultValue="32" required />
          </label>
          <button type="submit">Prepare Linux environment</button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
