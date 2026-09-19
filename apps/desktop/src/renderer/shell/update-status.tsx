import { useEffect, useState } from "react";
import { Schema } from "effect";
import { ArrowDownCircleIcon } from "lucide-react";
import { UpdateState } from "../../updates.js";
import { request } from "@/state";

export function UpdateStatus() {
  const [state, setState] = useState<UpdateState>({ status: "disabled" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = Schema.decodeUnknownSync(UpdateState)(await request("update.status"));
        if (!stopped) setState(next);
        if (next.status === "disabled") return;
      } catch {
        /* Update state is advisory; the next refresh retries. */
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const label =
    state.status === "downloading"
      ? `Downloading ${state.version} (${Math.round(state.percent)}%)`
      : state.status === "ready"
        ? `Restart to update to ${state.version}`
        : state.status === "waiting"
          ? `Update ${state.version} installs when VMs finish`
          : state.status === "installing"
            ? `Installing ${state.version}`
            : undefined;
  if (!label) return null;
  return (
    <button
      type="button"
      disabled={state.status !== "ready"}
      onClick={() =>
        void request("update.install").then((value) =>
          setState(Schema.decodeUnknownSync(UpdateState)(value)),
        )
      }
      className="flex min-h-7 items-center gap-2.5 rounded-lg px-2.5 py-1 text-left text-primary outline-none enabled:hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:text-muted-foreground"
    >
      <ArrowDownCircleIcon className="size-4 shrink-0" aria-hidden />
      <span aria-live="polite">{label}</span>
    </button>
  );
}
