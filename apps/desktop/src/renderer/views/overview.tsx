import { useState } from "react";
import { CircleStopIcon, EllipsisIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { Instance, Operation } from "../../../../../packages/protocol/src/index.js";
import {
  Details,
  EmptyState,
  ExpandableRow,
  List,
  Mono,
  Notice,
  Page,
  Row,
  Section,
  StatCard,
  usePages,
} from "@/components/layout";
import { Reason } from "@/components/hint";
import { OsTile } from "@/components/os-icon";
import { InstanceStatus, OperationStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cancellableCommands, commandLabels, preparationCommands } from "@/lib/operations";
import { MigrationResult } from "@/views/migration-result";
import { PreparationResult } from "@/views/preparation-result";
import { useStateApi } from "@/state";

const filters = {
  all: () => true,
  active: (operation: Operation) => ["accepted", "running"].includes(operation.status),
  failed: (operation: Operation) => ["failed", "cancelled"].includes(operation.status),
} as const;

const cloudLabels = {
  connected: "Cloud connected",
  connecting: "Connecting to cloud",
  unavailable: "Cloud unavailable",
  removed: "Removed from account",
  unconfigured: "Local only",
} as const;

export function Overview() {
  const { snapshot, submit, perform, machineId } = useStateApi();
  const [filter, setFilter] = useState<keyof typeof filters>("all");
  const paused = snapshot?.machine.paused;
  const operations = snapshot?.operations ?? [];
  const attention = operations.filter((operation) => operation.status === "action_required");
  const active = operations.filter(filters.active);
  const history = operations.filter(
    (operation) => operation.status !== "action_required" && filters[filter](operation),
  );
  const { items, pager, reset } = usePages(history, 8);
  const instances = snapshot?.instances ?? [];
  const running = instances.filter((instance) => instance.status === "running");
  const interrupted = instances.filter((instance) => instance.status === "interrupted");
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
          label="Operations"
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
        <Section
          title="Needs you"
          description="These operations are paused until you finish a step."
        >
          <List>
            {attention.map((operation) => (
              <OperationRow key={operation.id} operation={operation} defaultOpen />
            ))}
          </List>
        </Section>
      )}
      <div className="grid items-start gap-10 @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:gap-8">
        <Section
          title="Operations"
          actions={
            <Tabs
              value={filter}
              onValueChange={(value: keyof typeof filters) => {
                setFilter(value);
                reset();
              }}
            >
              <TabsList className="group-data-horizontal/tabs:h-7">
                <TabsTrigger value="all" className="px-2.5 text-xs">
                  All
                </TabsTrigger>
                <TabsTrigger value="active" className="px-2.5 text-xs">
                  Active
                </TabsTrigger>
                <TabsTrigger value="failed" className="px-2.5 text-xs">
                  Failed
                </TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          {!history.length ? (
            <EmptyState>
              {operations.length
                ? "No operations match this filter."
                : "Operations you start appear here with their progress."}
            </EmptyState>
          ) : (
            <List>
              {items.map((operation) => (
                <OperationRow key={operation.id} operation={operation} />
              ))}
              {pager}
            </List>
          )}
        </Section>
        <Section title="Virtual machines">
          {!instances.length ? (
            <EmptyState>No virtual machines are running.</EmptyState>
          ) : (
            <List>
              {instances.map((instance) => (
                <InstanceRow key={instance.id} instance={instance} />
              ))}
            </List>
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

function OperationRow({
  operation,
  defaultOpen = false,
}: {
  operation: Operation;
  defaultOpen?: boolean;
}) {
  const { submit } = useStateApi();
  const preparation = preparationCommands.includes(operation.command);
  const migration =
    (operation.command === "migration.analyze" || operation.command === "migration.publish") &&
    operation.status === "succeeded";
  const cancellable =
    cancellableCommands.includes(operation.command) && operation.status === "running";
  const reconcilable = operation.command === "runner.run" && operation.status === "action_required";
  // Preparations resume or discard, an interrupted runner reconciles; everything else that waits
  // for a person can only be read and closed.
  const dismissable = operation.status === "action_required" && !preparation && !reconcilable;
  const result: unknown = operation.result;
  const nextStep =
    typeof result === "object" &&
    result &&
    "nextStep" in result &&
    typeof result.nextStep === "string"
      ? result.nextStep
      : undefined;
  return (
    <ExpandableRow
      defaultOpen={defaultOpen}
      title={commandLabels[operation.command] ?? operation.command}
      summary={operation.message}
      aside={
        <>
          <span className="hidden text-xs text-muted-foreground tabular-nums @2xl:inline">
            {formatRelative(operation.updatedAt)}
          </span>
          <OperationStatus status={operation.status} />
        </>
      }
    >
      <p className="max-w-[72ch] text-foreground/85" data-selectable>
        {operation.message}
      </p>
      {nextStep && (
        <p className="max-w-[72ch] text-muted-foreground" data-selectable>
          {nextStep}
        </p>
      )}
      {preparation && (
        <PreparationResult
          result={operation.result}
          macos={operation.command.includes("macos")}
          windows={operation.command.includes("windows")}
          resumable={operation.status === "action_required"}
        />
      )}
      {migration && <MigrationResult result={operation.result} />}
      <Details
        items={[
          ["Started", formatDateTime(operation.createdAt)],
          ["Last update", formatDateTime(operation.updatedAt)],
          ["Operation ID", <Mono key="id">{operation.id}</Mono>],
        ]}
      />
      {(cancellable || reconcilable || dismissable) && (
        <div className="flex flex-wrap gap-2">
          {dismissable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submit({ type: "operation.cancel", id: operation.id })}
            >
              Dismiss
            </Button>
          )}
          {reconcilable && (
            <Button
              size="sm"
              onClick={() => void submit({ type: "runner.reconcile", id: operation.id })}
            >
              Reconcile runner
            </Button>
          )}
          {cancellable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submit({ type: "operation.cancel", id: operation.id })}
            >
              Cancel operation
            </Button>
          )}
        </div>
      )}
    </ExpandableRow>
  );
}
