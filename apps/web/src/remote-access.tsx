import { useState } from "react";
import { SignIn, UserButton } from "@clerk/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Schema } from "effect";
import { api } from "../../../convex/_generated/api.js";
import { ControllerApproval } from "../../../packages/protocol/src/controller.js";

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
      <h1>Remote control access</h1>
      <p>
        A signed-in CLI or desktop can control the machines owned by your Vectis account. Jobs and
        VM disks stay on those machines.
      </p>
      {isLoading ? (
        <p role="status">Checking your account...</p>
      ) : !isAuthenticated ? (
        <SignIn
          routing="hash"
          fallbackRedirectUrl="/connect?controller=1"
          signUpFallbackRedirectUrl="/connect?controller=1"
        />
      ) : (
        <>
          <UserButton />
          {state === "approved" ? (
            <p role="status">
              Approved. Return to Vectis and run <code>vectis login finish</code>.
            </p>
          ) : request ? (
            <section>
              <h2>Approve {request.name}</h2>
              <p>
                Verification code:{" "}
                <strong>{request.requestDigest.slice(0, 12).toUpperCase()}</strong>
              </p>
              <p>
                Only approve a login you started yourself, with a matching code. This grants control
                of your machines for up to 90 days. You can revoke it below at any time.
              </p>
              <button disabled={state === "working"} onClick={() => void connect()}>
                {state === "working" ? "Approving..." : "Approve remote control"}
              </button>
            </section>
          ) : (
            <p>
              Run <code>vectis login</code> from the CLI to begin a new connection.
            </p>
          )}
          <section>
            <h2>Connected clients</h2>
            {connections === undefined ? (
              <p role="status">Loading connections...</p>
            ) : connections.length === 0 ? (
              <p>No remote clients are connected.</p>
            ) : (
              <ul>
                {connections.map((connection) => (
                  <li key={connection.id}>
                    {connection.name} / expires{" "}
                    {new Date(connection.expiresAt).toLocaleDateString()}
                    <button
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
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
