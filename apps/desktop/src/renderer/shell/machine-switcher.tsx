import { useState } from "react";
import { Schema } from "effect";
import { ChevronsUpDownIcon, RefreshCwIcon } from "lucide-react";
import { Identifier } from "../../../../../packages/protocol/src/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrandMark } from "@/components/brand-mark";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { request, useStateApi } from "@/state";

export const Machines = Schema.Array(
  Schema.Struct({
    id: Identifier,
    name: Schema.String,
    online: Schema.Boolean,
  }),
);

export function MachineSwitcher() {
  const { machineId, selectMachine, snapshot, ready } = useStateApi();
  const [machines, setMachines] = useState<typeof Machines.Type | null>(null);
  const [issue, setIssue] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshed, setRefreshed] = useState<number | null>(null);
  async function load() {
    setLoading(true);
    const started = Date.now();
    try {
      setMachines(Schema.decodeUnknownSync(Machines)(await request("machines.list")));
      setIssue("");
      setRefreshed(Date.now());
    } catch {
      setMachines(null);
      setIssue("Sign in under Connections to control your other Macs.");
    } finally {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 400 - (Date.now() - started))),
      );
      setLoading(false);
    }
  }
  const status = !ready
    ? "Connecting"
    : !snapshot
      ? machineId
        ? "Waiting for machine"
        : "Service not running"
      : snapshot.machine.paused
        ? "New VMs paused"
        : machineId
          ? "Remote control"
          : "Service running";
  const tone = !ready
    ? "bg-neutral"
    : !snapshot
      ? "bg-attention"
      : snapshot.machine.paused
        ? "bg-neutral"
        : "bg-success";
  return (
    <DropdownMenu onOpenChange={(open) => void (open && load())}>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-xl p-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 aria-expanded:bg-foreground/5"
        aria-label="Choose machine"
      >
        <BrandMark className="size-7 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {snapshot?.machine.name ?? (machineId ? "Remote machine" : "This Mac")}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", tone)} aria-hidden />
            {status}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 pb-2">
            <span className="text-xs font-semibold text-foreground">Control machine</span>
            <span className="text-xs font-normal text-muted-foreground">
              {issue || "Choose which Mac this window manages."}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={machineId ?? ""}
            onValueChange={(value: string) => selectMachine(value || undefined)}
          >
            <DropdownMenuRadioItem value="">This Mac</DropdownMenuRadioItem>
            {machineId && !machines?.some((machine) => machine.id === machineId) && (
              <DropdownMenuRadioItem value={machineId}>
                Selected remote machine
              </DropdownMenuRadioItem>
            )}
            {machines?.map((machine) => (
              <DropdownMenuRadioItem key={machine.id} value={machine.id}>
                <span className="flex-1 truncate">{machine.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      machine.online ? "bg-success" : "bg-neutral",
                    )}
                    aria-hidden
                  />
                  {machine.online ? "Online" : "Offline"}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {!issue && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem closeOnClick={false} disabled={loading} onClick={() => void load()}>
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
              {loading ? "Refreshing" : "Refresh machines"}
              {!loading && refreshed && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatRelative(refreshed)}
                </span>
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
