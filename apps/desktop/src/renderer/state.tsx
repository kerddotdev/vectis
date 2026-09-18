import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { Snapshot, type Command } from "../../../../packages/protocol/src/index.js";
import type { DesktopAction } from "../bridge.js";

export async function request(action: DesktopAction, input?: unknown, machineId?: string) {
  if (!window.vectis)
    throw new Error("Open this interface through the Vectis desktop application.");
  const reply = await window.vectis.request(action, input, machineId);
  if (!reply.ok) throw new Error(`${reply.error.message} ${reply.error.nextStep}`);
  return reply.data;
}
const State = createContext<{
  machineId: string | undefined;
  selectMachine: (id: string | undefined) => void;
  snapshot: Snapshot | null;
  ready: boolean;
  error: string;
  dismissError: () => void;
  perform: (action: DesktopAction, input?: unknown) => Promise<unknown>;
  submit: (command: Command) => Promise<unknown>;
} | null>(null);
export function StateProvider({ children }: { children: ReactNode }) {
  const [machineId, setMachineId] = useState<string>();
  const selected = useRef(machineId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
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
      if (!stopped) timer = setTimeout(() => void refresh(), machineId ? 5000 : 2000);
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [machineId]);
  async function perform(action: DesktopAction, input?: unknown) {
    setError("");
    try {
      const value = await request(action, input, machineId);
      return selected.current === machineId ? value : undefined;
    } catch (issue) {
      if (selected.current === machineId)
        setError(issue instanceof Error ? issue.message : "The request failed.");
      return undefined;
    }
  }
  return (
    <State
      value={{
        machineId,
        selectMachine: (id) => {
          selected.current = id;
          setMachineId(id);
          setSnapshot(null);
          setReady(false);
          setError("");
        },
        snapshot,
        ready,
        error,
        dismissError: () => setError(""),
        perform,
        submit: (command) => perform("command", { key: crypto.randomUUID(), command }),
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
