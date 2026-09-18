import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Schema } from "effect";
import { api } from "../../../../convex/_generated/api.js";
import { ControllerApproval } from "../../../../packages/protocol/src/controller.js";
import { Account, SignInPanel } from "./Connect.js";
import { Button, Card, Code, Heading, Notice, Pending } from "./ui.js";

export function readControllerRequest(deploymentUrl: string | undefined) {
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("controller");
    if (encoded) {
      if (encoded.length > 2048) return null;
      sessionStorage.setItem("vectis-controller-request", encoded);
      history.replaceState(null, "", "/connect?controller=1");
    }
    const request = Schema.decodeUnknownSync(ControllerApproval, { onExcessProperty: "error" })(
      JSON.parse(sessionStorage.getItem("vectis-controller-request") ?? "null"),
    );
    return request.deploymentUrl === deploymentUrl ? request : null;
  } catch {
    return null;
  }
}

export function RemoteAccess({ request }: { request: ControllerApproval | null }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const approve = useMutation(api.controllers.approve);
  const revoke = useMutation(api.controllers.revoke);
  const connections = useQuery(api.controllers.list, isAuthenticated ? {} : "skip");
  const [state, setState] = useState<"idle" | "working" | "approved">("idle");
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState("");
  async function connect() {
    if (!request) return;
    setState("working");
    setError("");
    try {
      if (request.expiresAt <= Date.now())
        throw new Error("This login request expired. Run vectis login again.");
      const { deploymentUrl: _url, ...input } = request;
      await approve(input);
      sessionStorage.removeItem("vectis-controller-request");
      setState("approved");
    } catch {
      setState("idle");
      setError("Remote access could not be approved. Check request expiry and retry from the CLI.");
    }
  }
  return (
    <>
      <Heading eyebrow="Remote control" title="Remote control access">
        <p>
          A signed-in CLI or desktop can control the machines owned by your Vectis account. Jobs and
          VM disks stay on those machines.
        </p>
      </Heading>
      {isLoading ? (
        <Pending>Checking your account</Pending>
      ) : !isAuthenticated ? (
        <SignInPanel redirect="/connect?controller=1" />
      ) : (
        <>
          <Account>Signed in to Vectis.</Account>
          {state === "approved" ? (
            <Notice tone="success">
              Approved. Return to Vectis and run <Code>vectis login finish</Code>.
            </Notice>
          ) : request ? (
            <Card label={`Approve ${request.name}`}>
              <h2 className="text-xl font-medium">Approve {request.name}</h2>
              <p className="flex flex-wrap items-baseline gap-3 text-muted">
                Verification code
                <span className="font-mono text-lg tracking-widest text-foreground">
                  {request.requestDigest.slice(0, 12).toUpperCase()}
                </span>
              </p>
              <Notice tone="attention">
                Only approve a login you started yourself, with a matching code. This grants control
                of your machines for up to 90 days. You can revoke it below at any time.
              </Notice>
              <div>
                <Button disabled={state === "working"} onClick={() => void connect()}>
                  {state === "working" ? "Approving" : "Approve remote control"}
                </Button>
              </div>
            </Card>
          ) : (
            <p className="text-muted">
              Run <Code>vectis login</Code> from the CLI to begin a new connection.
            </p>
          )}
          <Card label="Connected clients">
            <h2 className="text-xl font-medium">Connected clients</h2>
            {connections === undefined ? (
              <Pending>Loading connections</Pending>
            ) : connections.length === 0 ? (
              <p className="text-muted">No remote clients are connected.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline">
                {connections.map((connection) => (
                  <li key={connection.id} className="flex items-center justify-between gap-4 py-3">
                    <span>
                      {connection.name}
                      <span className="block text-[14px] text-muted">
                        Expires {new Date(connection.expiresAt).toLocaleDateString()}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      disabled={revoking !== ""}
                      onClick={() => {
                        setRevoking(connection.id);
                        setError("");
                        void revoke({ id: connection.id })
                          .catch(() =>
                            setError("Revocation failed. Retry before removing local credentials."),
                          )
                          .finally(() => setRevoking(""));
                      }}
                    >
                      Revoke access
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
    </>
  );
}
