import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Schema } from "effect";
import {
  commandActivity,
  Operation,
  Snapshot,
  type Command,
} from "../../../../packages/protocol/src/index.js";
import type { DesktopAction } from "../bridge.js";
import { notify } from "@/lib/notify";
import { commandLabels, settingLabels } from "@/lib/operations";

export class RequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export async function request(action: DesktopAction, input?: unknown, machineId?: string) {
  if (!window.vectis)
    throw new Error("Open this interface through the Vectis desktop application.");
  const reply = await window.vectis.request(action, input, machineId);
  if (!reply.ok)
    throw new RequestError(reply.error.code, `${reply.error.message} ${reply.error.nextStep}`);
  return reply.data;
}
// Reads never change anything, so they never need the views to look again.
const reads: ReadonlySet<DesktopAction> = new Set([
  "status",
  "jobs",
  "repositories",
  "github.accounts",
  "doctor",
  "storage",
  "logs",
  "machines.list",
  "update.status",
  "cli.status",
]);
function nextStep(operation: Operation) {
  const result: unknown = operation.result;
  return typeof result === "object" && result && "nextStep" in result
    ? typeof result.nextStep === "string"
      ? result.nextStep
      : undefined
    : undefined;
}
const State = createContext<{
  machineId: string | undefined;
  selectMachine: (id: string | undefined) => void;
  snapshot: Snapshot | null;
  ready: boolean;
  invalidate: () => void;
  perform: (action: DesktopAction, input?: unknown) => Promise<unknown>;
  submit: (command: Command, success?: string) => Promise<Operation | undefined>;
} | null>(null);
export function StateProvider({ children }: { children: ReactNode }) {
  const [machineId, setMachineId] = useState<string>();
  // A machine can be selected, left and selected again; only a counter tells a reply from the
  // first selection apart from one that belongs to the current view.
  const selection = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ready, setReady] = useState(false);
  const invalidate = useRef(() => {});
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let reading = false;
    let requested = false;
    async function refresh() {
      if (stopped) return;
      if (reading) {
        requested = true;
        return;
      }
      reading = true;
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const value = Schema.decodeUnknownSync(Snapshot)(
            await request("status", undefined, machineId),
          );
          if (!stopped) setSnapshot(value);
        } catch {
          if (!stopped) setSnapshot(null);
        }
        if (!stopped) setReady(true);
      }
      reading = false;
      if (stopped) return;
      if (requested) {
        requested = false;
        void refresh();
        return;
      }
      timer = setTimeout(() => void refresh(), machineId ? 5000 : 2000);
    }
    invalidate.current = () => void refresh();
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [machineId]);
  async function perform(action: DesktopAction, input?: unknown) {
    const generation = selection.current;
    try {
      const value = await request(action, input, machineId);
      return generation === selection.current ? value : undefined;
    } catch (issue) {
      if (generation === selection.current)
        notify.error(issue instanceof Error ? issue.message : "The request failed.", {
          id: `request:${action}`,
        });
      return undefined;
    } finally {
      if (!reads.has(action) && generation === selection.current) invalidate.current();
    }
  }
  async function submit(command: Command, success?: string) {
    const title = commandLabels[command.type] ?? command.type;
    // A setting is finished when the service says so, so the app waits and reports the real
    // outcome. Work that takes minutes only reports that it started.
    const settles = commandActivity[command.type] === "setting";
    const value = await perform(settles ? "command.settle" : "command", {
      key: crypto.randomUUID(),
      command,
    });
    if (value === undefined) return undefined;
    const operation = Schema.decodeUnknownSync(Operation)(value);
    if (!settles) notify.started(title, { description: "Started" });
    else if (operation.status === "succeeded")
      notify.success(success ?? settingLabels[command.type] ?? title);
    else if (operation.status === "action_required")
      notify.attention(title, { description: nextStep(operation) ?? operation.message });
    else if (operation.status !== "accepted" && operation.status !== "running")
      notify.error(title, { description: nextStep(operation) ?? operation.message });
    return operation;
  }
  return (
    <State
      value={{
        machineId,
        selectMachine: (id) => {
          selection.current += 1;
          setMachineId(id);
          setSnapshot(null);
          setReady(false);
        },
        snapshot,
        ready,
        invalidate: () => invalidate.current(),
        perform,
        submit,
      }}
    >
      {children}
    </State>
  );
}
export function useStateApi() {
  const state = useContext(State);
  if (!state) throw new Error("Missing desktop state.");
  return state;
}
