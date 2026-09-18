import { useState, type ReactNode } from "react";
import { Schema } from "effect";
import { ExternalLinkIcon } from "lucide-react";
import { Notice, Page, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { request, useStateApi } from "@/state";

const Verification = Schema.Struct({ verificationCode: Schema.String });

function Code({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Notice>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded-lg bg-background px-2 py-1 font-mono text-[15px] tracking-widest text-foreground ring-1 ring-border">
          {value}
        </span>
        {children}
      </span>
    </Notice>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-card p-4 ring-1 ring-border">{children}</div>
  );
}

export function Connections() {
  const { perform, machineId, selectMachine } = useStateApi();
  const [pairCode, setPairCode] = useState("");
  const [pairMessage, setPairMessage] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [pending, setPending] = useState(false);
  async function pair() {
    const value = await perform("cloud.pair");
    if (value === undefined) return;
    setPairMessage("");
    setPairCode(Schema.decodeUnknownSync(Verification)(value).verificationCode);
  }
  async function finish() {
    if ((await perform("cloud.finish")) !== undefined) {
      setPairCode("");
      setPairMessage("This Mac is connected.");
    }
  }
  async function remote(action: "controller.login" | "controller.finish" | "controller.logout") {
    setPending(true);
    setLoginMessage("");
    try {
      const value = await request(action);
      if (action === "controller.login")
        setLoginCode(Schema.decodeUnknownSync(Verification)(value).verificationCode);
      if (action === "controller.finish") {
        const result = Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }))(value);
        if (result.state === "linked") setLoginCode("");
        setLoginMessage(
          result.state === "linked"
            ? "Signed in. Choose a machine from the sidebar."
            : "Browser approval is still pending.",
        );
      }
      if (action === "controller.logout") {
        selectMachine(undefined);
        setLoginCode("");
        setLoginMessage("Remote access revoked. This Mac is selected.");
      }
    } catch (issue) {
      setLoginMessage(issue instanceof Error ? issue.message : "Connection failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <Page
      title="Connections"
      description="Link GitHub, connect this Mac to your Vectis account, and control other machines."
    >
      <Section
        title="GitHub"
        description="Install the Vectis GitHub App on the accounts and organizations whose repositories should use your runners."
      >
        <div>
          <Button variant="secondary" onClick={() => void perform("open.github")}>
            <ExternalLinkIcon />
            Connect GitHub in browser
          </Button>
        </div>
      </Section>
      <Section
        title="This Mac"
        description="Pair this Mac so GitHub jobs and remote commands can reach it. Build files never leave it."
      >
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!machineId} onClick={() => void pair()}>
              Begin pairing
            </Button>
            <Button variant="secondary" disabled={!!machineId} onClick={() => void finish()}>
              Finish approved pairing
            </Button>
          </div>
          {pairCode && (
            <Code value={pairCode}>Compare this code in your browser, then approve this Mac.</Code>
          )}
          {pairMessage && <Notice tone="success">{pairMessage}</Notice>}
          {machineId && (
            <p className="text-muted-foreground">Switch to This Mac in the sidebar to pair it.</p>
          )}
        </Card>
      </Section>
      <Section
        title="Remote control"
        description="Sign in to control Vectis on your other machines. File paths then refer to the selected machine."
      >
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void remote("controller.login")}>
              Sign in
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void remote("controller.finish")}
            >
              Finish sign-in
            </Button>
            <Button
              variant="ghost"
              className="ml-auto"
              disabled={pending}
              onClick={() => void remote("controller.logout")}
            >
              Sign out
            </Button>
          </div>
          {loginCode && (
            <Code value={loginCode}>
              Compare this code in the browser, approve, then finish sign-in.
            </Code>
          )}
          {loginMessage && <Notice>{loginMessage}</Notice>}
        </Card>
      </Section>
    </Page>
  );
}
