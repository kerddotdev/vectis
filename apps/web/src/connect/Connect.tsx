import { StrictMode, useState, type ReactNode } from "react";
import { ClerkProvider, SignIn, UserButton, useAuth } from "@clerk/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexError } from "convex/values";
import { CircleCheckIcon, LaptopIcon, MonitorSmartphoneIcon, FolderGit2Icon } from "lucide-react";
import {
  ControllerApproval,
  PairingApproval,
  readControllerRequest,
  readPairingRequest,
} from "./approvals.js";
import { site } from "@vectis/design/site";
import { Dashboard } from "./dashboard.js";
import { Pending, TipProvider } from "./ui.js";

const deploymentUrl: string | undefined = import.meta.env.VITE_CONVEX_URL;
const publishableKey: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function errorCode(issue: unknown) {
  return issue instanceof ConvexError &&
    typeof issue.data === "object" &&
    issue.data !== null &&
    "code" in issue.data
    ? String(issue.data.code)
    : "";
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

function Shell({ children, signedIn }: { children: ReactNode; signedIn: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-hairline bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-3 px-5">
          <a
            href="/"
            className="flex items-center gap-2 rounded-lg text-[16px] font-semibold tracking-[-0.01em] no-underline outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <img src="/favicon.svg" alt="" width="20" height="20" />
            Vectis
          </a>
          <span className="h-4 w-px bg-hairline-strong" aria-hidden />
          <span className="text-[15px] text-muted">Account</span>
          <nav className="ml-auto flex items-center gap-1" aria-label="Help">
            <a
              href="/docs/guides/local-setup"
              className="rounded-full px-3 py-1.5 text-[14px] text-muted no-underline transition hover:bg-hairline hover:text-foreground"
            >
              Setup guide
            </a>
            {signedIn && (
              <span className="ml-2 flex items-center">
                <UserButton />
              </span>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2 px-5 py-6 text-[13px] text-muted">
          <span>
            Vectis by{" "}
            <a className="no-underline hover:text-foreground" href={site.author.url}>
              {site.author.name}
            </a>
          </span>
          <a className="no-underline hover:text-foreground" href="/security">
            Security
          </a>
          <a className="no-underline hover:text-foreground" href="/docs">
            Documentation
          </a>
        </div>
      </footer>
    </div>
  );
}

const promises = [
  {
    icon: LaptopIcon,
    title: "Connect your Macs",
    text: "Approve the Macs that run your jobs. Build files and VM disks never leave them.",
  },
  {
    icon: FolderGit2Icon,
    title: "Choose repositories",
    text: "Link GitHub and pick which repositories use which prepared environment.",
  },
  {
    icon: MonitorSmartphoneIcon,
    title: "Control them from anywhere",
    text: "Let the Vectis app or CLI on one Mac manage your others.",
  },
];

function SignInScreen({ context }: { context: string | null }) {
  return (
    <div className="mx-auto grid max-w-[1180px] items-center gap-12 px-5 py-14 md:py-20 lg:grid-cols-[1fr_auto] lg:gap-20">
      <div className="flex max-w-[46ch] flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-title font-medium text-balance">
            {context ?? "Your Vectis account."}
          </h1>
          <p className="text-lede text-muted">
            {context
              ? "Sign in to continue. You will see the request and its verification code before anything is approved."
              : "Vectis runs on your Mac without an account. Sign in here when you want GitHub to start jobs on it."}
          </p>
        </div>
        {!context && (
          <ul className="flex flex-col gap-5">
            {promises.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-surface ring-1 ring-hairline">
                  <Icon className="size-[18px] text-brand" aria-hidden />
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="block text-[15px] text-muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-center lg:justify-end">
        <SignIn
          routing="hash"
          fallbackRedirectUrl={location.pathname + location.search}
          signUpFallbackRedirectUrl={location.pathname + location.search}
        />
      </div>
    </div>
  );
}

export function Approved({
  title,
  children,
  onContinue,
}: {
  title: string;
  children: ReactNode;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-[520px] flex-col items-center gap-5 px-5 py-20 text-center">
      <CircleCheckIcon className="size-10 text-success" aria-hidden />
      <h1 className="text-title font-medium">{title}</h1>
      <div className="text-lede text-muted">{children}</div>
      <button
        type="button"
        onClick={onContinue}
        className="mt-2 text-[15px] text-brand underline-offset-4 hover:underline"
      >
        Open your account overview
      </button>
    </div>
  );
}

function Route() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pairing, setPairing] = useState(() => readPairingRequest(deploymentUrl));
  const [controller, setController] = useState(() => readControllerRequest(deploymentUrl));
  const context = pairing
    ? `Connect ${pairing.name} to your account.`
    : controller
      ? `Approve remote control for ${controller.name}.`
      : null;
  return (
    <Shell signedIn={isAuthenticated}>
      {isLoading ? (
        <Pending>Checking your account</Pending>
      ) : !isAuthenticated ? (
        <SignInScreen context={context} />
      ) : pairing ? (
        <PairingApproval request={pairing} onDone={() => setPairing(null)} />
      ) : controller ? (
        <ControllerApproval request={controller} onDone={() => setController(null)} />
      ) : (
        <Dashboard />
      )}
    </Shell>
  );
}

export default function Connect() {
  const [convex] = useState(() => (deploymentUrl ? new ConvexReactClient(deploymentUrl) : null));
  if (!convex || !publishableKey)
    return (
      <Shell signedIn={false}>
        <div className="mx-auto max-w-[560px] px-5 py-24">
          <h1 className="text-title font-medium">Account setup is unavailable.</h1>
          <p className="mt-3 text-lede text-muted">
            Public authentication configuration is missing from this build.
          </p>
        </div>
      </Shell>
    );
  return (
    <StrictMode>
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl="/connect"
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
          <TipProvider>
            <Route />
          </TipProvider>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </StrictMode>
  );
}
