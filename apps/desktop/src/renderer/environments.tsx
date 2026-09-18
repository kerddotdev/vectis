import { PrepareLinux } from "./prepare-linux.js";
import { useState, type FormEvent } from "react";
import { Schema } from "effect";
import { Environment } from "../../../../packages/protocol/src/index.js";
import { useStateApi } from "./state.js";

export function Environments() {
  const { snapshot, submit, perform } = useStateApi();
  const [storage, setStorage] = useState("");
  const [issue, setIssue] = useState("");
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssue("");
    const data = new FormData(event.currentTarget);
    try {
      const environment = Schema.decodeUnknownSync(Environment)({
        id: data.get("id"),
        name: data.get("name"),
        os: data.get("os"),
        basePath: data.get("basePath"),
        cpu: Number(data.get("cpu")),
        memoryMiB: Number(data.get("memoryMiB")),
        state: "ready",
        ...(storage ? { storagePath: storage } : {}),
        ...(data.get("sshUser") ? { sshUser: data.get("sshUser") } : {}),
        ...(data.get("sshKeyPath") ? { sshKeyPath: data.get("sshKeyPath") } : {}),
        ...(data.get("knownHostsPath") ? { knownHostsPath: data.get("knownHostsPath") } : {}),
        ...(data.get("tpmStatePath") ? { tpmStatePath: data.get("tpmStatePath") } : {}),
        ...(data.get("firmwarePath") ? { firmwarePath: data.get("firmwarePath") } : {}),
        ...(data.get("firmwareVarsPath") ? { firmwareVarsPath: data.get("firmwareVarsPath") } : {}),
      });
      await submit({ type: "environment.register", environment });
    } catch {
      setIssue("Check the environment identifier, OS, paths and resource values.");
    }
  }
  return (
    <>
      <h1>Environments</h1>
      <PrepareLinux />
      <p>Prepared guest images are the clean starting point for each virtual machine.</p>
      {snapshot?.environments.map((environment) => (
        <EnvironmentRow key={environment.id} environment={environment} />
      ))}
      <details className="section">
        <summary>Register a prepared image</summary>
        <p>
          Use an existing Linux disk, macOS bundle or Windows image. Guided image preparation is
          still being integrated.
        </p>
        <form onSubmit={(event) => void register(event)}>
          <label>
            Identifier
            <input required name="id" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}" />
          </label>
          <label>
            Name
            <input required name="name" />
          </label>
          <label>
            Operating system
            <select name="os">
              <option value="linux">Ubuntu Linux ARM64</option>
              <option value="macos">macOS ARM64</option>
              <option value="windows">Windows ARM64</option>
            </select>
          </label>
          <label>
            Base image or bundle path
            <input required name="basePath" />
          </label>
          <div className="row">
            <label>
              CPU cores
              <input name="cpu" type="number" min="1" defaultValue="2" required />
            </label>
            <label>
              Memory (MiB)
              <input
                name="memoryMiB"
                type="number"
                min="512"
                step="512"
                defaultValue="4096"
                required
              />
            </label>
          </div>
          <label>
            VM storage directory
            <input
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              placeholder="Service default"
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void perform("chooseDirectory").then((value) => {
                if (typeof value === "string") setStorage(value);
              })
            }
          >
            Choose storage folder
          </button>
          <details>
            <summary>Guest SSH access</summary>
            <p>
              Provide guest-only credentials. The pinned host key entry must use the environment ID
              as its host alias. No host credentials are copied into the VM.
            </p>
            <label>
              Guest username
              <input name="sshUser" />
            </label>
            <label>
              Guest SSH identity file
              <input name="sshKeyPath" />
            </label>
            <label>
              Pinned known_hosts file
              <input name="knownHostsPath" />
            </label>
          </details>
          <details>
            <summary>Windows firmware and TPM</summary>
            <label>
              Prepared TPM state directory
              <input name="tpmStatePath" />
            </label>
            <label>
              UEFI code image
              <input name="firmwarePath" />
            </label>
            <label>
              UEFI variable template
              <input name="firmwareVarsPath" />
            </label>
          </details>
          <button disabled={!snapshot} type="submit">
            Register image
          </button>
          {issue && <p role="alert">{issue}</p>}
        </form>
      </details>
    </>
  );
}
function EnvironmentRow({ environment }: { environment: Environment }) {
  const { submit, perform } = useStateApi();
  const [cpu, setCpu] = useState(environment.cpu);
  const [memoryMiB, setMemory] = useState(environment.memoryMiB);
  const [storagePath, setStorage] = useState(environment.storagePath ?? "");
  return (
    <section className="section">
      <div className="row spread">
        <div>
          <h2>{environment.name}</h2>
          <span className="status">
            {environment.os} / {environment.state}
          </span>
        </div>
        <button
          disabled={environment.state !== "ready"}
          onClick={() => void submit({ type: "environment.start", id: environment.id })}
        >
          Start clean VM
        </button>
      </div>
      <p className="path">{environment.basePath}</p>
      <details>
        <summary>Resources and storage</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit({
              type: "environment.configure",
              id: environment.id,
              cpu,
              memoryMiB,
              ...(storagePath ? { storagePath } : {}),
            });
          }}
        >
          <div className="row">
            <label>
              CPU cores
              <input
                type="number"
                required
                min="1"
                value={cpu}
                onChange={(e) => setCpu(e.target.valueAsNumber)}
              />
            </label>
            <label>
              Memory (MiB)
              <input
                type="number"
                required
                min="512"
                step="512"
                value={memoryMiB}
                onChange={(e) => setMemory(e.target.valueAsNumber)}
              />
            </label>
          </div>
          <label>
            VM directory
            <input
              value={storagePath}
              onChange={(e) => setStorage(e.target.value)}
              placeholder="Service default"
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void perform("chooseDirectory").then((value) => {
                if (typeof value === "string") setStorage(value);
              })
            }
          >
            Choose folder
          </button>
          <button type="submit">Save for future VMs</button>
        </form>
      </details>
    </section>
  );
}
