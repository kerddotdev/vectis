import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api.js";
import { Header } from "./dashboard.js";
import { Button, Code, Empty, Notice, Panel, Pending, relative } from "./ui.js";

export function AccessTab({
  controllers,
}: {
  controllers: FunctionReturnType<typeof api.controllers.list> | undefined;
}) {
  const revoke = useMutation(api.controllers.revoke);
  const [revoking, setRevoking] = useState("");
  const [error, setError] = useState("");
  return (
    <>
      <Header
        title="Remote access"
        description="Apps and terminals that can control the Macs on your account. Each sign-in lasts up to 90 days."
      />
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!controllers ? (
        <Pending>Loading remote access</Pending>
      ) : controllers.length === 0 ? (
        <Empty title="Nothing has remote access">
          To control your other Macs, open Connections in the Vectis app and choose Sign in with
          browser, or run <Code>vectis login</Code>.
        </Empty>
      ) : (
        <Panel>
          <ul className="flex flex-col divide-y divide-hairline">
            {controllers.map((controller) => (
              <li key={controller.id} className="flex items-center gap-4 py-3.5 pr-4 pl-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{controller.name}</p>
                  <p className="text-[14px] text-muted">
                    Approved {relative(controller.createdAt)} · expires{" "}
                    {new Date(controller.expiresAt).toLocaleDateString(undefined, {
                      dateStyle: "medium",
                    })}
                  </p>
                </div>
                <Button
                  small
                  variant="secondary"
                  disabled={revoking !== ""}
                  onClick={() => {
                    setRevoking(controller.id);
                    setError("");
                    void revoke({ id: controller.id })
                      .catch(() => setError("Access could not be revoked. Try again."))
                      .finally(() => setRevoking(""));
                  }}
                >
                  {revoking === controller.id ? "Revoking" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
