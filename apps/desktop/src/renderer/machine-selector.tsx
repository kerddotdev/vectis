import { useState } from "react";
import { Schema } from "effect";
import { Identifier } from "../../../../packages/protocol/src/index.js";
import { request, useStateApi } from "./state.js";

const Machines = Schema.Array(
  Schema.Struct({
    id: Identifier,
    name: Schema.String,
    online: Schema.Boolean,
    revoked: Schema.Boolean,
  }),
);
export function MachineSelector() {
  const { machineId, selectMachine } = useStateApi();
  const [machines, setMachines] = useState<typeof Machines.Type>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function act(
    action: "machines.list" | "controller.login" | "controller.finish" | "controller.logout",
  ) {
    setPending(true);
    setMessage("");
    try {
      const value = await request(action);
      if (action === "machines.list") setMachines(Schema.decodeUnknownSync(Machines)(value));
      if (action === "controller.login") {
        const login = Schema.decodeUnknownSync(Schema.Struct({ verificationCode: Schema.String }))(
          value,
        );
        setMessage(
          `Compare code ${login.verificationCode} in the browser, approve, then finish sign-in.`,
        );
      }
      if (action === "controller.finish") {
        const result = Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }))(value);
        setMessage(
          result.state === "linked"
            ? "Signed in. Refresh machines to select a host."
            : "Browser approval is still pending.",
        );
      }
      if (action === "controller.logout") {
        selectMachine(undefined);
        setMachines([]);
        setMessage("Remote access revoked. This Mac is selected.");
      }
    } catch (issue) {
      setMessage(issue instanceof Error ? issue.message : "Connection failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="Machine selection">
      <label>
        Control machine
        <select
          value={machineId ?? ""}
          disabled={pending}
          onChange={(event) => selectMachine(event.target.value || undefined)}
        >
          <option value="">This Mac (local)</option>
          {machineId && !machines.some((machine) => machine.id === machineId) && (
            <option value={machineId}>Selected remote machine</option>
          )}
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id} disabled={machine.revoked}>
              {machine.name} ({machine.revoked ? "revoked" : machine.online ? "online" : "offline"})
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button disabled={pending} onClick={() => void act("machines.list")}>
          Refresh machines
        </button>
        <button disabled={pending} onClick={() => void act("controller.login")}>
          Sign in for remote control
        </button>
        <button disabled={pending} onClick={() => void act("controller.finish")}>
          Finish sign-in
        </button>
        <button disabled={pending} onClick={() => void act("controller.logout")}>
          Sign out
        </button>
      </div>
      {machineId && <p>Remote control is active. File paths refer to the selected machine.</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
