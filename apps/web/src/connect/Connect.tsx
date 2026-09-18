import { StrictMode, useState } from "react";
import { ClerkProvider, SignIn, UserButton, useAuth } from "@clerk/react";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { api } from "../../../../convex/_generated/api.js";
import { PairingDescriptor } from "../../../../packages/protocol/src/pairing.js";
import { GitHubConnections } from "./github.js";
import { RemoteAccess, readControllerRequest } from "./remote-access.js";
import { Button, Card, Code, Heading, linkButton, Notice, Pending } from "./ui.js";

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

function resolveColor(name: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return color;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${red}, ${green}, ${blue})`;
}

export function SignInPanel({ redirect }: { redirect: string }) {
  return (
    <div className="flex justify-center">
      <SignIn routing="hash" fallbackRedirectUrl={redirect} signUpFallbackRedirectUrl={redirect} />
    </div>
  );
}

export function Account({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <UserButton />
      <span>{children}</span>
    </div>
  );
}

function Pairing() {
  const [request] = useState(readPairing);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const approve = useMutation(api.pairings.approve);
  const [state, setState] = useState<"idle" | "working" | "approved">("idle");
  const [error, setError] = useState("");
  if (!request)
    return (
      <>
        <Heading eyebrow="Connect" title="Start from your Mac.">
          <p>
            Run <Code>vectis cloud pair</Code> or choose Begin pairing in the Vectis app, then open
            the link it provides to connect this account to your machine.
          </p>
        </Heading>
        <div className="flex flex-wrap gap-3">
          <a className={linkButton} href="/docs/guides/local-setup">
            Read the setup guide
          </a>
          <a
            className="inline-flex h-10 items-center rounded-full px-5 text-[15px] font-medium text-foreground ring-1 ring-hairline-strong transition hover:bg-hairline"
            href="/connect?github=1"
          >
            Connect a GitHub account
          </a>
        </div>
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
      <Heading eyebrow="Approved" title="Your Mac can connect.">
        <p>Return to Vectis and finish pairing. You can close this tab.</p>
      </Heading>
    );
  return (
    <>
      <Heading eyebrow="Connect" title="Connect your Mac.">
        <p>
          Give your Vectis account access to this machine. Jobs and virtual machine disks stay on
          your Mac.
        </p>
      </Heading>
      <Card label="Pairing request">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3 text-[15px]">
          <dt className="text-muted">Machine</dt>
          <dd className="font-medium">{request.name}</dd>
          <dt className="text-muted">Verification code</dt>
          <dd className="font-mono text-lg tracking-widest">
            {request.requestDigest.slice(0, 12).toUpperCase()}
          </dd>
        </dl>
        <Notice tone="attention">
          Only continue if you started this request on your own machine and the code matches Vectis.
          Do not approve a link someone sent you.
        </Notice>
        {isLoading ? (
          <Pending>Checking your account</Pending>
        ) : !isAuthenticated ? (
          <SignInPanel redirect="/connect" />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Account>Your signed-in account will own this connection.</Account>
            <Button disabled={state === "working"} onClick={() => void connect()}>
              {state === "working" ? "Connecting" : "Connect this Mac"}
            </Button>
          </div>
        )}
      </Card>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
    </>
  );
}

function Route() {
  const [query] = useState(() => new URLSearchParams(location.search));
  const [controller] = useState(() =>
    query.get("controller") === "1" ? readControllerRequest(deploymentUrl) : null,
  );
  if (query.get("controller") === "1") return <RemoteAccess request={controller} />;
  if (query.get("github") === "1") return <GitHubConnections />;
  return <Pairing />;
}

export default function Connect() {
  const [convex] = useState(() => (deploymentUrl ? new ConvexReactClient(deploymentUrl) : null));
  if (!convex || !publishableKey)
    return (
      <Heading eyebrow="Connect" title="Connection setup is unavailable.">
        <p>Public authentication configuration is missing from this build.</p>
      </Heading>
    );
  return (
    <StrictMode>
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl="/"
        appearance={{
          variables: {
            colorBackground: resolveColor("--vectis-raised"),
            colorForeground: resolveColor("--vectis-foreground"),
            colorMutedForeground: resolveColor("--vectis-muted"),
            colorPrimary: resolveColor("--vectis-brand-fill"),
            colorPrimaryForeground: resolveColor("--vectis-on-brand"),
            colorInput: resolveColor("--vectis-surface"),
            colorInputForeground: resolveColor("--vectis-foreground"),
            colorNeutral: resolveColor("--vectis-foreground"),
            fontFamily: "General Sans, system-ui, sans-serif",
            borderRadius: "0.875rem",
          },
        }}
      >
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <div className="flex flex-col gap-8">
            <Route />
          </div>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </StrictMode>
  );
}
