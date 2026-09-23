import { useEffect, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { ExternalLinkIcon, LaptopIcon, MonitorSmartphoneIcon } from "lucide-react";
import { GitHubIcon } from "@/components/github-icon";
import { Notice, Page } from "@/components/layout";
import { Hint, Reason } from "@/components/hint";
import { StatusBadge, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { notify } from "@/lib/notify";
import { Machines } from "@/shell/machine-switcher";
import { request, RequestError, useStateApi } from "@/state";

const Verification = Schema.Struct({ verificationCode: Schema.String });
const codes = { pair: "", login: "" };

function Card({
  icon,
  title,
  hint,
  status,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  status?: { tone: Tone; label: string } | undefined;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rise-in flex flex-col gap-4 rounded-2xl bg-card p-5 ring-1 ring-border">
      <div className="flex items-start gap-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/80">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-[15px] font-medium">{title}</h2>
            {hint}
            {status && (
              <span className="ml-auto">
                <StatusBadge tone={status.tone} label={status.label} />
              </span>
            )}
          </div>
          <div className="mt-1 max-w-[62ch] text-muted-foreground">{description}</div>
        </div>
      </div>
      {children && (
        <div className="flex flex-col gap-3 pl-[50px] not-has-[>:not(:empty)]:hidden">
          {children}
        </div>
      )}
    </section>
  );
}

function VerificationCode({ value, children }: { value: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-muted px-4 py-3">
      <span className="font-mono text-[15px] tracking-[0.2em] text-foreground" data-selectable>
        {value}
      </span>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

export function Connections() {
  const { perform, machineId, selectMachine, snapshot, invalidate } = useStateApi();
  const [pairCode, setPairCode] = useState(codes.pair);
  const [loginCode, setLoginCode] = useState(codes.login);
  const [account, setAccount] = useState<
    { state: "checking" } | { state: "signed-out" } | { state: "signed-in"; machines: number }
  >({ state: "checking" });
  const [keychainMissing, setKeychainMissing] = useState(false);
  const [disconnect, setDisconnect] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    codes.pair = pairCode;
    codes.login = loginCode;
  }, [pairCode, loginCode]);
  async function checkAccount() {
    try {
      const machines = Schema.decodeUnknownSync(Machines)(await request("machines.list"));
      setAccount({ state: "signed-in", machines: machines.length });
    } catch (issue) {
      setKeychainMissing(issue instanceof RequestError && issue.code === "runtime_missing");
      setAccount({ state: "signed-out" });
    }
  }
  useEffect(() => {
    void checkAccount();
  }, []);
  async function run(name: string, work: () => Promise<void>) {
    setPending(name);
    try {
      await work();
    } catch (issue) {
      notify.error(issue instanceof Error ? issue.message : "The request failed.");
    } finally {
      setPending(null);
      invalidate();
    }
  }
  const cloud = snapshot?.cloud?.state ?? "unconfigured";
  const paired = cloud !== "unconfigured";
  const keychainReason = keychainMissing && "Requires the Keychain Helper. See Diagnostics.";
  const pairReason = (!snapshot && "Start the Vectis service first.") || keychainReason;
  return (
    <Page
      title="Connections"
      description="Vectis works locally without an account. Connect it to your Vectis account when you want GitHub to start jobs here, or to control your other Macs."
    >
      <div className="flex flex-col gap-4">
        <Card
          icon={<LaptopIcon className="size-[18px]" />}
          title="This Mac"
          hint={
            <Hint>
              Pairing gives your Vectis account a secure link to this Mac. The Mac connects out to
              the cloud, so no port is opened, and build files stay here.
            </Hint>
          }
          status={
            machineId
              ? undefined
              : cloud === "connected"
                ? { tone: "success", label: "Connected" }
                : cloud === "connecting"
                  ? { tone: "running", label: "Connecting" }
                  : cloud === "removed"
                    ? { tone: "attention", label: "Removed from account" }
                    : cloud === "unavailable"
                      ? { tone: "attention", label: "Unavailable" }
                      : { tone: "idle", label: "Not connected" }
          }
          description={
            machineId
              ? "You are controlling another machine. Switch to This Mac in the sidebar to manage its connection."
              : cloud === "removed"
                ? "This Mac was removed from its account. Disconnect it here, then connect it again whenever you want."
                : paired
                  ? "GitHub jobs and remote commands can reach this Mac."
                  : "Connect this Mac to your Vectis account so GitHub jobs can start on it."
          }
        >
          {!machineId && cloud === "unavailable" && snapshot?.cloud?.message && (
            <Notice tone="attention">{snapshot.cloud.message}</Notice>
          )}
          {!paired && pairCode && !machineId && (
            <VerificationCode value={pairCode}>
              Check that your browser shows the same code, approve, then finish here.
            </VerificationCode>
          )}
          <div className="flex flex-wrap gap-2">
            {!paired && !pairCode && !machineId && (
              <Reason reason={pairReason}>
                <Button
                  disabled={!!pairReason || pending !== null}
                  onClick={() =>
                    void run("pair", async () => {
                      const value = await request("cloud.pair");
                      setPairCode(Schema.decodeUnknownSync(Verification)(value).verificationCode);
                    })
                  }
                >
                  <ExternalLinkIcon />
                  Connect in browser
                </Button>
              </Reason>
            )}
            {!paired && pairCode && !machineId && (
              <>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run("finish", async () => {
                      await request("cloud.finish");
                      setPairCode("");
                      notify.success("This Mac is connected.");
                    })
                  }
                >
                  {pending === "finish" ? "Finishing" : "Finish connecting"}
                </Button>
                <Button variant="ghost" disabled={pending !== null} onClick={() => setPairCode("")}>
                  Start over
                </Button>
              </>
            )}
            {paired && !machineId && cloud !== "connected" && cloud !== "removed" && (
              <Button
                variant="secondary"
                disabled={pending !== null}
                onClick={() =>
                  void run("check", async () => {
                    await request("cloud.finish");
                    notify.success("The connection was verified.");
                  })
                }
              >
                {pending === "check" ? "Checking" : "Check connection"}
              </Button>
            )}
          </div>
          {paired && !machineId && (
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run("disconnect", async () => {
                  await request("cloud.disconnect");
                  setDisconnect("");
                  notify.success("This Mac no longer has a cloud connection.", {
                    description:
                      "Remove it on the account page too, then connect again whenever you want.",
                  });
                });
              }}
            >
              <Field className="flex-1">
                <FieldLabel htmlFor="cloud-disconnect">
                  Type disconnect to remove this Mac's saved connection and credential
                </FieldLabel>
                <Input
                  id="cloud-disconnect"
                  required
                  value={disconnect}
                  onChange={(event) => setDisconnect(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={pending !== null || disconnect.trim() !== "disconnect"}
              >
                {pending === "disconnect" ? "Disconnecting" : "Disconnect"}
              </Button>
            </form>
          )}
        </Card>

        <Card
          icon={<GitHubIcon className="size-[18px]" />}
          title="GitHub"
          description="Link your GitHub accounts and choose which repositories run on your Macs. This happens on the Vectis website, where you sign in with the same account."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void perform("open.github")}>
              <ExternalLinkIcon />
              Open GitHub connections
            </Button>
            {!paired && !machineId && (
              <span className="text-xs text-muted-foreground">
                Connect this Mac first so repositories can use it.
              </span>
            )}
          </div>
        </Card>

        <Card
          icon={<MonitorSmartphoneIcon className="size-[18px]" />}
          title="Other Macs"
          hint={
            <Hint>
              After signing in, choose a machine from the switcher at the bottom of the sidebar.
              File paths then refer to that machine. Sign-in lasts 90 days.
            </Hint>
          }
          status={
            account.state === "signed-in"
              ? { tone: "success", label: "Signed in" }
              : account.state === "signed-out"
                ? { tone: "idle", label: "Not signed in" }
                : undefined
          }
          description={
            account.state === "signed-in"
              ? `You can control ${account.machines} ${account.machines === 1 ? "machine" : "machines"} on your account from the sidebar.`
              : "Sign in to control Vectis on your other Macs from this window."
          }
        >
          {account.state === "signed-out" && loginCode && (
            <VerificationCode value={loginCode}>
              Check that your browser shows the same code, approve, then finish here.
            </VerificationCode>
          )}
          <div className="flex flex-wrap gap-2">
            {account.state === "signed-out" && !loginCode && (
              <Reason reason={keychainReason}>
                <Button
                  disabled={!!keychainReason || pending !== null}
                  onClick={() =>
                    void run("login", async () => {
                      const value = await request("controller.login");
                      setLoginCode(Schema.decodeUnknownSync(Verification)(value).verificationCode);
                    })
                  }
                >
                  <ExternalLinkIcon />
                  Sign in with browser
                </Button>
              </Reason>
            )}
            {account.state === "signed-out" && loginCode && (
              <>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run("login-finish", async () => {
                      const result = Schema.decodeUnknownSync(
                        Schema.Struct({ state: Schema.String }),
                      )(await request("controller.finish"));
                      if (result.state !== "linked") {
                        notify.attention("The browser has not approved this sign-in yet.");
                        return;
                      }
                      setLoginCode("");
                      await checkAccount();
                      notify.success("Signed in. Choose a machine from the sidebar.");
                    })
                  }
                >
                  {pending === "login-finish" ? "Finishing" : "Finish sign-in"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => setLoginCode("")}
                >
                  Start over
                </Button>
              </>
            )}
            {account.state === "signed-in" && (
              <Button
                variant="secondary"
                disabled={pending !== null}
                onClick={() =>
                  void run("logout", async () => {
                    await request("controller.logout");
                    selectMachine(undefined);
                    setAccount({ state: "signed-out" });
                    notify.success("Signed out. This window controls this Mac again.");
                  })
                }
              >
                {pending === "logout" ? "Signing out" : "Sign out"}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </Page>
  );
}
