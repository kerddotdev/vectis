import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { Schema } from "effect";
import { api } from "../../../../convex/_generated/api.js";
import { ControllerApproval as ControllerRequest } from "../../../../packages/protocol/src/controller.js";
import { PairingDescriptor } from "../../../../packages/protocol/src/pairing.js";
import { Approved, errorCode } from "./Connect.js";
import { Button, Notice, VerificationCode } from "./ui.js";

const pairingKey = "vectis-pairing";
const controllerKey = "vectis-controller-request";

function readRequest<T>(
  hashKey: string,
  storageKey: string,
  decode: (value: unknown) => T & { deploymentUrl: string; expiresAt: number },
  deploymentUrl: string | undefined,
) {
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get(hashKey);
    if (encoded) {
      if (encoded.length > 2048) return null;
      sessionStorage.setItem(storageKey, encoded);
      history.replaceState(null, "", "/connect");
    }
    const value = decode(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
    if (value.expiresAt <= Date.now()) sessionStorage.removeItem(storageKey);
    return value.deploymentUrl === deploymentUrl && value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
}

export const readPairingRequest = (deploymentUrl: string | undefined) =>
  readRequest(
    "request",
    pairingKey,
    Schema.decodeUnknownSync(PairingDescriptor, { onExcessProperty: "error" }),
    deploymentUrl,
  );

export const readControllerRequest = (deploymentUrl: string | undefined) =>
  readRequest(
    "controller",
    controllerKey,
    Schema.decodeUnknownSync(ControllerRequest, { onExcessProperty: "error" }),
    deploymentUrl,
  );

function Request({
  title,
  lede,
  name,
  digest,
  warning,
  action,
  working,
  error,
  onApprove,
  onDecline,
}: {
  title: string;
  lede: ReactNode;
  name: string;
  digest: string;
  warning: ReactNode;
  action: string;
  working: boolean;
  error: string;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-[560px] flex-col gap-8 px-5 py-14 md:py-20">
      <div className="flex flex-col gap-3">
        <h1 className="text-title font-medium text-balance">{title}</h1>
        <p className="text-lede text-muted">{lede}</p>
      </div>
      <div className="flex flex-col gap-5 rounded-3xl bg-surface p-6 ring-1 ring-hairline">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[15px]">
          <dt className="text-muted">Requested by</dt>
          <dd className="font-medium">{name}</dd>
        </dl>
        <div className="flex flex-col gap-2">
          <p className="text-[14px] text-muted">Verification code</p>
          <VerificationCode value={digest.slice(0, 12).toUpperCase()} />
          <p className="text-[14px] text-muted">
            It must match the code shown in the Vectis app or terminal on your Mac.
          </p>
        </div>
        <Notice tone="attention">{warning}</Notice>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={working} onClick={onApprove}>
            {working ? "Approving" : action}
          </Button>
          <Button variant="quiet" disabled={working} onClick={onDecline}>
            Not now
          </Button>
        </div>
      </div>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}

export function PairingApproval({
  request,
  onDone,
}: {
  request: PairingDescriptor;
  onDone: () => void;
}) {
  const approve = useMutation(api.pairings.approve);
  const [state, setState] = useState<"idle" | "working" | "approved">("idle");
  const [error, setError] = useState("");
  function decline() {
    sessionStorage.removeItem(pairingKey);
    onDone();
  }
  async function connect() {
    setState("working");
    setError("");
    try {
      if (request.expiresAt <= Date.now())
        throw new Error("This request expired. Start connecting again from your Mac.");
      const { deploymentUrl: _url, ...approval } = request;
      await approve(approval);
      sessionStorage.removeItem(pairingKey);
      setState("approved");
    } catch (issue) {
      const code = errorCode(issue);
      setError(
        code === "machine_already_linked"
          ? "This Mac is already connected to an account. Its existing connection stays in place."
          : code
            ? `The request could not be approved (${code}). Start connecting again from your Mac.`
            : issue instanceof Error
              ? issue.message
              : "The request could not be approved. Try again.",
      );
      setState("idle");
    }
  }
  if (state === "approved")
    return (
      <Approved title={`${request.name} can connect.`} onContinue={onDone}>
        Return to Vectis on that Mac and choose Finish connecting. You can close this tab.
      </Approved>
    );
  return (
    <Request
      title={`Connect ${request.name} to your account?`}
      lede="Jobs from repositories you connect will run on this Mac. Build files and VM disks stay on it."
      name={request.name}
      digest={request.requestDigest}
      warning="Only approve a request you started yourself on your own Mac. Never approve a link someone sent you."
      action="Connect this Mac"
      working={state === "working"}
      error={error}
      onApprove={() => void connect()}
      onDecline={decline}
    />
  );
}

export function ControllerApproval({
  request,
  onDone,
}: {
  request: ControllerRequest;
  onDone: () => void;
}) {
  const approve = useMutation(api.controllers.approve);
  const [state, setState] = useState<"idle" | "working" | "approved">("idle");
  const [error, setError] = useState("");
  function decline() {
    sessionStorage.removeItem(controllerKey);
    onDone();
  }
  async function connect() {
    setState("working");
    setError("");
    try {
      if (request.expiresAt <= Date.now())
        throw new Error("This sign-in request expired. Start signing in again.");
      const { deploymentUrl: _url, ...input } = request;
      await approve(input);
      sessionStorage.removeItem(controllerKey);
      setState("approved");
    } catch (issue) {
      setError(
        issue instanceof Error && !errorCode(issue)
          ? issue.message
          : "Remote control could not be approved. Start signing in again from the app or CLI.",
      );
      setState("idle");
    }
  }
  if (state === "approved")
    return (
      <Approved title="Remote control approved." onContinue={onDone}>
        Return to Vectis and choose Finish sign-in, or run <code>vectis login finish</code> in your
        terminal.
      </Approved>
    );
  return (
    <Request
      title={`Let ${request.name} control your Macs?`}
      lede="It can start runners and manage environments on every Mac connected to your account. Access lasts up to 90 days and can be revoked at any time."
      name={request.name}
      digest={request.requestDigest}
      warning="Only approve a sign-in you started yourself, with a matching code."
      action="Approve remote control"
      working={state === "working"}
      error={error}
      onApprove={() => void connect()}
      onDecline={decline}
    />
  );
}
