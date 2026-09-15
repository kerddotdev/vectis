import { StrictMode } from "react";
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
import { StateProvider, useStateApi } from "./state.js";
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
          </div>
        ))}
      </section>
    </>
  );
}
const rootRoute = createRootRoute({ component: Layout });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview }),
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
