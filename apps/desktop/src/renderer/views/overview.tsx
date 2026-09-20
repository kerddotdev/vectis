import { useNavigate } from "@tanstack/react-router";
import { CircleStopIcon, EllipsisIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { Instance } from "../../../../../packages/protocol/src/index.js";
import { ActivityRow } from "@/components/activity-row";
import { EmptyState, List, Notice, Page, Row, Section, StatCard } from "@/components/layout";
import { Reason } from "@/components/hint";
import { OsTile } from "@/components/os-icon";
import { InstanceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format";
import { useStateApi } from "@/state";

const cloudLabels = {
  connected: "Cloud connected",
  connecting: "Connecting to cloud",
  unavailable: "Cloud unavailable",
  removed: "Removed from account",
  unconfigured: "Local only",
} as const;

export function Overview() {
  const { snapshot, submit, perform, machineId } = useStateApi();
  const navigate = useNavigate();
  const paused = snapshot?.machine.paused;
  const activities = snapshot?.activities ?? [];
  const attention = activities.filter((activity) => activity.status === "action_required");
  const active = activities.filter((activity) => ["accepted", "running"].includes(activity.status));
  const recentActivity = activities
    .filter((activity) => activity.status !== "action_required")
    .slice(0, 8);
  const instances = snapshot?.instances ?? [];
  const running = instances.filter((instance) => instance.status === "running");
  const interrupted = instances.filter((instance) => instance.status === "interrupted");
  // Every operation starts a VM, so the full list grows without bound. A VM that still runs or
  // needs cleanup always stays visible; the rest of the room goes to the newest finished ones.
  const newest = (list: readonly Instance[]) =>
    [...list].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const recent = [
    ...newest([...running, ...interrupted]),
    ...newest(
      instances.filter((instance) => !["running", "interrupted"].includes(instance.status)),
    ),
  ].slice(0, 8);
  const olderInstances = instances.length - recent.length;
  const environments = snapshot?.environments ?? [];
  const ready = environments.filter((environment) => environment.state === "ready");
  return (
    <Page
      title="Overview"
      description="What this machine is running, and anything that needs you."
      actions={
        <>
          <Reason reason={!snapshot && "Start the service to change VM intake."}>
            <Button
              variant="secondary"
              size="sm"
              disabled={!snapshot}
              onClick={() => void submit({ type: "machine.pause", paused: !paused })}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "Resume new VMs" : "Pause new VMs"}
            </Button>
          </Reason>
          {!machineId && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="Service actions" />}
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem
                  disabled={!snapshot}
                  onClick={() => void perform("service.stop-idle")}
                >
                  Stop service if idle
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void perform("service.update")}>
                  Use this app's runtime
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void perform("service.recover-update")}>
                  Recover runtime update
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!!snapshot}
                  onClick={() => void perform("service.uninstall")}
                >
                  Remove login service
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard
          label="Service"
          value={!snapshot ? "Offline" : paused ? "Paused" : "Running"}
          tone={!snapshot || paused ? "attention" : "success"}
          detail={
            !snapshot
              ? "Not reachable"
              : paused
                ? "New VMs are paused"
                : cloudLabels[snapshot.cloud?.state ?? "unconfigured"]
          }
        />
        <StatCard
          label="Virtual machines"
          value={running.length}
          tone={running.length ? "running" : undefined}
          detail={
            interrupted.length
              ? `${interrupted.length} need cleanup`
              : running.length
                ? "Running now"
                : "None running"
          }
        />
        <StatCard
          label="Activity"
          value={active.length + attention.length}
          tone={attention.length ? "attention" : active.length ? "running" : undefined}
          detail={
            attention.length
              ? `${attention.length} waiting for you`
              : active.length
                ? "In progress"
                : "Nothing in progress"
          }
        />
        <StatCard
          label="Environments"
          value={ready.length}
          detail={
            environments.length ? `Ready, of ${environments.length} prepared` : "None prepared yet"
          }
        />
      </div>
      {snapshot?.cloud?.state === "unavailable" && snapshot.cloud.message && (
        <Notice tone="attention" title="The Vectis cloud is unavailable">
          {snapshot.cloud.message}
        </Notice>
      )}
      {snapshot?.cloud?.state === "removed" && (
        <Notice tone="attention" title="This Mac was removed from its account">
          Disconnect the saved connection in Connections, then connect this Mac again whenever you
          want.
        </Notice>
      )}
      {attention.length > 0 && (
        <Section title="Needs you" description="These are paused until you finish a step.">
          <List>
            {attention.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} defaultOpen />
            ))}
          </List>
        </Section>
      )}
      <div className="grid items-start gap-10 @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:gap-8">
        <Section
          title="Recent activity"
          actions={
            <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/activities" })}>
              See all
            </Button>
          }
        >
          {!recentActivity.length ? (
            <EmptyState>What you ask this Mac to do appears here with its progress.</EmptyState>
          ) : (
            <List>
              {recentActivity.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </List>
          )}
        </Section>
        <Section title="Recent virtual machines">
          {!instances.length ? (
            <EmptyState>No virtual machines are running.</EmptyState>
          ) : (
            <>
              <List>
                {recent.map((instance) => (
                  <InstanceRow key={instance.id} instance={instance} />
                ))}
              </List>
              {olderInstances > 0 && (
                <p className="px-1 text-xs text-muted-foreground">
                  {olderInstances} older {olderInstances === 1 ? "VM is" : "VMs are"} kept with the
                  activity that started {olderInstances === 1 ? "it" : "them"}.
                </p>
              )}
            </>
          )}
        </Section>
      </div>
    </Page>
  );
}

function InstanceRow({ instance }: { instance: Instance }) {
  const { snapshot, submit } = useStateApi();
  const environment = snapshot?.environments.find((item) => item.id === instance.environmentId);
  return (
    <Row
      leading={environment && <OsTile os={environment.os} />}
      title={environment?.name ?? instance.environmentId}
      detail={
        <span className="inline-flex items-center gap-1.5">
          <InstanceStatus status={instance.status} inline />
          <span>· {formatRelative(instance.createdAt)}</span>
        </span>
      }
      trailing={
        instance.status === "running" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Stop VM"
                  onClick={() => void submit({ type: "instance.stop", id: instance.id })}
                />
              }
            >
              <CircleStopIcon />
            </TooltipTrigger>
            <TooltipContent>Stop VM</TooltipContent>
          </Tooltip>
        ) : instance.status === "interrupted" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void submit({ type: "instance.reconcile", id: instance.id })}
                />
              }
            >
              Reconcile
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              The service lost track of this VM. Reconciling checks whether it still runs and cleans
              it up.
            </TooltipContent>
          </Tooltip>
        ) : undefined
      }
    />
  );
}
