import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { MachineRepositories } from "../../../../packages/protocol/src/repositories.js";
import { Diagnostics } from "../../../../packages/protocol/src/diagnostics.js";
import { StorageReport } from "../../../../packages/protocol/src/storage.js";
import { StateProvider, useStateApi } from "./state.js";
import { RepositoryJobs } from "./repository-jobs.js";
import { Environments } from "./environments.js";
import "./style.css";
function Layout() {
  const { snapshot, error, perform } = useStateApi();
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          Vectis <span>/</span>
        </div>
        <nav aria-label="Main navigation">
          <Link to="/" activeOptions={{ exact: true }}>
            Overview
          </Link>
          <Link to="/environments">Environments</Link>
          <Link to="/storage">Storage</Link>
          <Link to="/connections">Connections</Link>
          <Link to="/diagnostics">Diagnostics</Link>
        </nav>
        <button className="secondary" onClick={() => void perform("open.docs")}>
          Documentation
        </button>
      </aside>
      <main>
        <header>
          <span className="status">{snapshot ? snapshot.machine.name : "Service unavailable"}</span>
          <span>{snapshot?.cloud?.state ?? "Local"}</span>
        </header>
        {!snapshot && (
          <section className="notice">
            <h2>Start the local service</h2>
            <p>The service manages your VMs independently of this window.</p>
            <button onClick={() => void perform("service.install")}>
              Install and start service
            </button>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <Outlet />
      </main>
    </div>
  );
}
function Overview() {
  const { snapshot, submit } = useStateApi();
  return (
    <>
      <h1>Your local runners.</h1>
      <p>Virtual machines and operations on this Mac.</p>
      <div className="row">
        <button
          disabled={!snapshot}
          onClick={() => void submit({ type: "machine.pause", paused: !snapshot?.machine.paused })}
        >
          {snapshot?.machine.paused ? "Resume new VMs" : "Pause new VMs"}
        </button>
        <span className="muted">Running work continues when paused.</span>
      </div>
      <section className="section">
        <h2>Virtual machines</h2>
        {!snapshot?.instances.length ? (
          <p>No virtual machines yet.</p>
        ) : (
          snapshot.instances.map((instance) => (
            <div className="record" key={instance.id}>
              <div>
                <strong>{instance.environmentId}</strong>
                <p className="muted">
                  {instance.cpu ?? "?"} cores / {instance.memoryMiB ?? "?"} MiB / {instance.status}
                </p>
                <code>{instance.id}</code>
              </div>
              {instance.status === "running" && (
                <button
                  className="secondary"
                  onClick={() => void submit({ type: "instance.stop", id: instance.id })}
                >
                  Stop VM
                </button>
              )}
              {instance.status === "interrupted" && (
                <button
                  onClick={() => void submit({ type: "instance.reconcile", id: instance.id })}
                >
                  Reconcile
                </button>
              )}
            </div>
          ))
        )}
      </section>
      <section className="section">
        <h2>Recent operations</h2>
        {snapshot?.operations.map((operation) => (
          <div className="record" key={operation.id}>
            <div>
              <strong>{operation.command}</strong>
              <p>{operation.message}</p>
              <code>{operation.id}</code>
            </div>
            <span className="status">{operation.status}</span>
            {operation.command === "runner.run" && operation.status === "action_required" && (
              <button
                className="secondary"
                onClick={() => void submit({ type: "runner.reconcile", id: operation.id })}
              >
                Reconcile runner
              </button>
            )}
            {(operation.command === "runner.run" || operation.command === "job.refresh") &&
              operation.status === "running" && (
                <button
                  className="secondary"
                  onClick={() => void submit({ type: "operation.cancel", id: operation.id })}
                >
                  Cancel operation
                </button>
              )}
          </div>
        ))}
      </section>
    </>
  );
}
function Doctor() {
  const { perform } = useStateApi();
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function inspect() {
    setPending(true);
    setError("");
    try {
      const value = await perform("doctor");
      if (value !== undefined) setReport(Schema.decodeUnknownSync(Diagnostics)(value));
    } catch {
      setError("The service returned an invalid diagnostic report.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <h1>Diagnostics</h1>
      <p>Inspect the running service's host and configured helpers.</p>
      <button disabled={pending} onClick={() => void inspect()}>
        {pending ? "Inspecting" : "Inspect service"}
      </button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <section className="section" aria-live="polite">
          <h2>Host</h2>
          <p>
            {report.host.platform} / {report.host.arch} / {report.host.cpus} cores /{" "}
            {report.host.memoryMiB} MiB
          </p>
          <p>{report.supportedHost ? "Supported host" : "Unsupported host"}</p>
          <h2>Runtime configuration</h2>
          <p>Configured paths still require a successful runtime check before starting a VM.</p>
          {Object.entries(report.configured).map(([name, configured]) => (
            <div className="record" key={name}>
              <strong>{name}</strong>
              <span>{configured ? "Configured" : "Not configured"}</span>
            </div>
          ))}
          <h2>Service state directory</h2>
          <code>{report.home}</code>
        </section>
      )}
    </>
  );
}
function Storage() {
  const { perform } = useStateApi();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState("");
  const size = (bytes: number | undefined) =>
    bytes === undefined ? "Unavailable" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return (
    <>
      <h1>Storage</h1>
      <p>Base images, virtual machine disks and allocated host blocks.</p>
      <button
        onClick={() =>
          void perform("storage").then((value) => {
            if (value === undefined) return;
            try {
              setReport(Schema.decodeUnknownSync(StorageReport)(value));
              setError("");
            } catch {
              setError("Storage information could not be read.");
            }
          })
        }
      >
        Measure storage
      </button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p className="muted">{report.allocationNote}</p>
          {report.environments.map((environment) => (
            <section className="section" key={environment.environmentId}>
              <h2>{environment.environmentId}</h2>
              {[{ id: "Base image", usage: environment.base }, ...environment.instances].map(
                (item) => (
                  <div key={item.id} className="record">
                    <div>
                      <strong>{item.id}</strong>
                      <p className="path">{item.usage.path}</p>
                      <p>
                        {size(item.usage.allocatedBytes)} allocated / {size(item.usage.fileBytes)}{" "}
                        file size
                      </p>
                      {item.usage.reason && <p>{item.usage.reason}</p>}
                      <details>
                        <summary>Host file breakdown</summary>
                        {item.usage.entries?.map((entry) => (
                          <p key={entry.name}>
                            {entry.name}: {size(entry.allocatedBytes)}
                          </p>
                        ))}
                      </details>
                    </div>
                  </div>
                ),
              )}
              <p className="muted">Guest filesystem breakdown is not available yet.</p>
            </section>
          ))}
        </>
      )}
    </>
  );
}
function Connections() {
  const { perform, submit, snapshot } = useStateApi();
  const [repositories, setRepositories] = useState<MachineRepositories | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  async function startRunner(bindingId: string) {
    setStarting(bindingId);
    try {
      const operation = await submit({ type: "runner.run", bindingId });
      if (operation !== undefined) setMessage("Runner requested. Follow its progress in Overview.");
    } finally {
      setStarting(null);
    }
  }
  async function discover() {
    setLoading(true);
    setRepositories(null);
    try {
      const result = await perform("repositories");
      if (result !== undefined)
        setRepositories(Schema.decodeUnknownSync(MachineRepositories)(result));
    } catch {
      setMessage("The service returned an invalid repository report.");
    } finally {
      setLoading(false);
    }
  }
  const [message, setMessage] = useState("");
  async function pair() {
    const value = await perform("cloud.pair");
    if (value === undefined) return;
    const result = Schema.decodeUnknownSync(Schema.Struct({ verificationCode: Schema.String }))(
      value,
    );
    setMessage(`Compare code ${result.verificationCode} in your browser, then approve this Mac.`);
  }
  async function finish() {
    const result = await perform("cloud.finish");
    if (result !== undefined) setMessage("This Mac is connected.");
  }
  return (
    <>
      <h1>Connections</h1>
      <p>Connect this Mac and your GitHub accounts. Build files stay on your machine.</p>
      <button onClick={() => void perform("open.github")}>Connect GitHub</button>
      <section className="section">
        <h2>Connected repositories</h2>
        <button disabled={loading} onClick={() => void discover()}>
          {loading ? "Checking access" : "Refresh repositories"}
        </button>
        {repositories?.length === 0 && <p>No repositories are connected to this Mac.</p>}
        {repositories?.map((repository) => (
          <div key={repository.id}>
            <div className="record">
              <strong>{repository.repositoryName}</strong>
              <span>{repository.environmentId}</span>
              <button
                disabled={starting !== null || !snapshot || snapshot.machine.paused}
                onClick={() => void startRunner(repository.id)}
              >
                {starting === repository.id ? "Requesting runner" : "Start runner"}
              </button>
            </div>
            <RepositoryJobs bindingId={repository.id} />
          </div>
        ))}
      </section>
      <section className="section">
        <h2>Connect this Mac</h2>
        <button onClick={() => void pair()}>Begin pairing</button>
        <button className="secondary" onClick={() => void finish()}>
          Finish approved pairing
        </button>
        {message && <p role="status">{message}</p>}
      </section>
    </>
  );
}
const rootRoute = createRootRoute({ component: Layout });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview }),
  createRoute({ getParentRoute: () => rootRoute, path: "/environments", component: Environments }),
  createRoute({ getParentRoute: () => rootRoute, path: "/storage", component: Storage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/diagnostics", component: Doctor }),
  createRoute({ getParentRoute: () => rootRoute, path: "/connections", component: Connections }),
]);
const router = createRouter({ routeTree, history: createHashHistory() });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing desktop root.");
createRoot(root).render(
  <StrictMode>
    <StateProvider>
      <RouterProvider router={router} />
    </StateProvider>
  </StrictMode>,
);
