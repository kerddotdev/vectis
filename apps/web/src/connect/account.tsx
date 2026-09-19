import { useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api.js";
import { Header } from "./dashboard.js";
import { Button, Confirm, Notice, Panel } from "./ui.js";

export function AccountTab() {
  const { user } = useUser();
  const clerk = useClerk();
  const remove = useMutation(api.account.remove);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Header
        title="Account"
        description="Your sign-in and everything Vectis stores for it. Removing a single Mac, repository connection or GitHub account is enough for most changes."
      />
      <Panel className="flex flex-col gap-5 p-5">
        <div className="flex flex-col gap-1">
          <p className="font-medium">Signed in as</p>
          <p className="text-[15px] text-muted">
            {user?.primaryEmailAddress?.emailAddress ?? user?.username ?? "your Vectis account"}
          </p>
        </div>
        <Notice>
          Deleting the account removes your Macs, repository connections, linked GitHub accounts,
          remote access and operation history, then deletes the sign-in itself. The Vectis app keeps
          running locally; run{" "}
          <code className="font-mono text-[14px]">vectis cloud disconnect</code> on each Mac. Remove
          the Vectis GitHub App on GitHub if you no longer want it installed.
        </Notice>
        <Button
          variant="danger"
          className="self-start ring-1 ring-danger/30"
          onClick={() => setDeleting(true)}
        >
          Delete account
        </Button>
      </Panel>
      <Confirm
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete your Vectis account?"
        description="This cannot be undone. Jobs already queued on GitHub stay there; your Macs keep their environments and VMs."
        phrase="delete"
        label="Delete account"
        onConfirm={async () => {
          await remove({});
          await user?.delete();
          await clerk.signOut({ redirectUrl: "/" });
        }}
      />
    </>
  );
}
