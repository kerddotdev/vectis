import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { Snapshot, type Command } from "../../../../packages/protocol/src/index.js";
import type { DesktopAction } from "../bridge.js";

export async function request(action: DesktopAction, input?: unknown) {
  if (!window.vectis)
    throw new Error("Open this interface through the Vectis desktop application.");
  const reply = await window.vectis.request(action, input);
  if (!reply.ok) throw new Error(`${reply.error.message} ${reply.error.nextStep}`);
  return reply.data;
}
const State = createContext<{
  snapshot: Snapshot | null;
  error: string;
  perform: (action: DesktopAction, input?: unknown) => Promise<unknown>;
  submit: (command: Command) => Promise<unknown>;
} | null>(null);
export function StateProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.visibilityState === "visible") {
        try {
          const value = Schema.decodeUnknownSync(Snapshot)(await request("status"));
          if (!stopped) setSnapshot(value);
        } catch {
          if (!stopped) setSnapshot(null);
        }
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  async function perform(action: DesktopAction, input?: unknown) {
    setError("");
    try {
      return await request(action, input);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The request failed.");
      return undefined;
    }
  }
  return (
    <State
      value={{
        snapshot,
        error,
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
