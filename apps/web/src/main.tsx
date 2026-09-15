import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, SignIn, UserButton, useAuth } from "@clerk/react";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { api } from "../../../convex/_generated/api.js";
import { PairingDescriptor } from "../../../packages/protocol/src/pairing.js";
import "./style.css";

const deploymentUrl: string | undefined = import.meta.env.VITE_CONVEX_URL;
const publishableKey: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
function readPairing() {
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("request");
    if (encoded) {
      if (encoded.length > 2048) throw new Error("Invalid request.");
      sessionStorage.setItem("vectis-pairing", encoded);
      history.replaceState(null, "", "/connect");
    }
    const value = Schema.decodeUnknownSync(PairingDescriptor, { onExcessProperty: "error" })(
      JSON.parse(sessionStorage.getItem("vectis-pairing") ?? "null"),
    );
    return value.deploymentUrl === deploymentUrl ? value : null;
  } catch {
    return null;
  }
}
const request = location.pathname === "/connect" ? readPairing() : null;

function Pairing() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const approve = useMutation(api.pairings.approve);
  const [state, setState] = useState<"idle" | "working" | "approved">("idle");
  const [error, setError] = useState("");
  if (!request)
    return (
      <>
        <h1>Start from your Mac.</h1>
        <p>
          Run <code>vectis cloud pair</code> and open the link it provides to connect this account
          to your machine.
        </p>
        <a className="button" href="/docs/guides/local-setup/">
          Read the setup guide
        </a>
      </>
    );
  async function connect() {
    if (!request) return;
    setState("working");
    setError("");
    try {
      if (request.expiresAt <= Date.now())
        throw new Error("This request expired. Start a new pairing from your Mac.");
      const { deploymentUrl: _url, ...approval } = request;
      await approve(approval);
      setState("approved");
      sessionStorage.removeItem("vectis-pairing");
    } catch (issue) {
      const code =
        issue instanceof ConvexError &&
        typeof issue.data === "object" &&
        issue.data !== null &&
        "code" in issue.data
          ? String(issue.data.code)
          : "";
      setError(
        code === "machine_already_linked"
          ? "This machine is already linked. Use its existing connection; pairing does not replace it."
          : code
            ? `Connection could not be approved (${code}). Return to your Mac and check the pairing request.`
            : issue instanceof Error
              ? issue.message
              : "Connection could not be approved. Try again.",
      );
      setState("idle");
    }
  }
  if (state === "approved")
    return (
      <>
        <span className="status">Approved</span>
        <h1>Your Mac can connect.</h1>
        <p>Return to Vectis and finish pairing. Your jobs will run on your machine.</p>
        <p className="muted">You can close this tab.</p>
      </>
    );
  return (
    <>
      <h1>Connect your Mac.</h1>
      <p>
        Give your Vectis account access to this machine. Jobs and virtual machine disks stay on your
        Mac.
      </p>
      <dl>
        <div>
          <dt>Machine</dt>
          <dd>{request.name}</dd>
        </div>
        <div>
          <dt>Verification code</dt>
          <dd className="code">{request.requestDigest.slice(0, 12).toUpperCase()}</dd>
        </div>
      </dl>
      <p className="notice">
        Only continue if you started this request on your own machine and the code matches Vectis.
        Do not approve a link someone sent you.
      </p>
      {isLoading ? (
        <p role="status">Checking your account...</p>
      ) : !isAuthenticated ? (
        <SignIn
          routing="hash"
          fallbackRedirectUrl="/connect"
          signUpFallbackRedirectUrl="/connect"
        />
      ) : (
        <>
          <div className="account">
            <UserButton />
            <span>Your signed-in account will own this connection.</span>
          </div>
          <button disabled={state === "working"} onClick={() => void connect()}>
            {state === "working" ? "Connecting..." : "Connect this Mac"}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function App() {
  return (
    <>
      <header>
        <a className="brand" href="/">
          Vectis<span aria-hidden="true">/</span>
        </a>
        <a href="/docs/">Documentation</a>
      </header>
      <main>
        {location.pathname === "/connect" ? (
          <Pairing />
        ) : (
          <>
            <span className="status">Local GitHub Actions</span>
            <h1>
              Your machines.
              <br />
              Your runners.
            </h1>
            <p>
              Run GitHub Actions on hardware you control. Connect your Mac, prepare a runner, and
              keep the work local.
            </p>
            <a className="button" href="/docs/guides/local-setup/">
              Set up Vectis <span aria-hidden="true">↗</span>
            </a>
            <p className="muted">Development preview. Apple Silicon first.</p>
          </>
        )}
      </main>
      <footer>
        <span>Built to run on your terms.</span>
        <a href="/llms.txt">For agents</a>
      </footer>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
const reactRoot = createRoot(root);
import.meta.hot?.dispose(() => reactRoot.unmount());
if (location.pathname !== "/connect")
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
else if (!deploymentUrl || !publishableKey)
  reactRoot.render(
    <main>
      <h1>Connection setup is unavailable.</h1>
      <p>Public authentication configuration is missing.</p>
      <a href="/docs/">Open documentation</a>
    </main>,
  );
else {
  const convex = new ConvexReactClient(deploymentUrl);
  reactRoot.render(
    <StrictMode>
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl="/"
        appearance={{
          variables: {
            colorBackground: "#20262e",
            colorForeground: "#e6e9ee",
            colorPrimary: "#b9d7fe",
            colorPrimaryForeground: "#182638",
            colorInput: "#15191e",
            colorInputForeground: "#e6e9ee",
          },
        }}
      >
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <App />
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </StrictMode>,
  );
}
