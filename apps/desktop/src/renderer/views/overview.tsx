import { EllipsisIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { Operation } from "../../../../../packages/protocol/src/index.js";
import { EmptyState, List, Mono, Page, Row, Section } from "@/components/layout";
import { InstanceStatus, OperationStatus, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MigrationResult } from "@/views/migration-result";
import { PreparationResult } from "@/views/preparation-result";
import { useStateApi } from "@/state";

const preparationCommands = [
  "environment.prepare-linux",
  "environment.resume",
  "environment.install-macos",
  "environment.resume-macos",
  "environment.open-macos-setup",
  "environment.connect-macos-guest",
  "environment.verify-macos-guest",
  "environment.finish-macos-setup",
  "environment.install-windows",
  "environment.resume-windows",
];
const cancellableCommands = [
  "environment.install-macos",
  "environment.resume-macos",
  "environment.open-macos-setup",
  "environment.connect-macos-guest",
  "environment.verify-macos-guest",
  "environment.install-windows",
  "environment.resume-windows",
  "environment.prepare-linux",
  "environment.resume",
  "runner.run",
  "job.refresh",
  "job.scan",
  "migration.analyze",
  "migration.publish",
  "repository.connect",
];
const commandLabels: Record<string, string> = {
  "environment.prepare-linux": "Prepare Linux image",
  "environment.resume": "Resume Linux preparation",
  "environment.install-macos": "Install macOS",
  "environment.resume-macos": "Resume macOS installation",
  "environment.open-macos-setup": "Open macOS setup console",
  "environment.connect-macos-guest": "Connect macOS guest SSH",
  "environment.verify-macos-guest": "Verify macOS guest SSH",
  "environment.finish-macos-setup": "Finish macOS setup",
  "environment.discard-macos": "Discard macOS setup",
  "environment.install-windows": "Install Windows",
  "environment.resume-windows": "Resume Windows installation",
  "environment.register": "Register environment",
  "environment.configure": "Configure environment",
  "environment.start": "Start clean VM",
  "instance.stop": "Stop VM",
  "instance.reconcile": "Reconcile VM",
  "runner.run": "Run runner",
  "runner.reconcile": "Reconcile runner",
  "repository.connect": "Connect repository",
  "repository.disconnect": "Disconnect repository",
  "repository.automatic": "Change automatic runners",
  "job.refresh": "Recover GitHub job",
  "job.scan": "Discover missing jobs",
  "migration.analyze": "Analyze workflow migration",
  "migration.publish": "Publish migration pull request",
  "machine.pause": "Change VM intake",
};

export function Overview() {
  const { snapshot, submit, perform, machineId } = useStateApi();
  const paused = snapshot?.machine.paused;
  return (
    <Page
      title="Overview"
      description="Virtual machines and recent operations on the selected machine."
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!snapshot}
            onClick={() => void submit({ type: "machine.pause", paused: !paused })}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Resume new VMs" : "Pause new VMs"}
          </Button>
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
      {paused && (
        <p className="-mt-4 text-muted-foreground">
          New VMs are paused. Running work continues until it finishes.
        </p>
      )}
      <Section title="Virtual machines">
        {!snapshot?.instances.length ? (
          <EmptyState>No virtual machines are running or waiting for cleanup.</EmptyState>
        ) : (
          <List>
            {snapshot.instances.map((instance) => (
              <Row
                key={instance.id}
                title={
                  snapshot.environments.find(
                    (environment) => environment.id === instance.environmentId,
                  )?.name ?? instance.environmentId
                }
                detail={
                  <>
                    {instance.cpu ?? "?"} cores · {instance.memoryMiB ?? "?"} MiB ·{" "}
                    <Mono>{instance.id}</Mono>
                  </>
                }
                trailing={
                  <>
                    <InstanceStatus status={instance.status} />
                    {instance.status === "running" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void submit({ type: "instance.stop", id: instance.id })}
                      >
                        Stop VM
                      </Button>
                    )}
                    {instance.status === "interrupted" && (
                      <Button
                        size="sm"
                        onClick={() => void submit({ type: "instance.reconcile", id: instance.id })}
                      >
                        Reconcile
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          </List>
        )}
      </Section>
      <Section title="Recent operations">
        {!snapshot?.operations.length ? (
          <EmptyState>Operations you start appear here with their progress.</EmptyState>
        ) : (
          <List>
            {snapshot.operations.map((operation) => (
              <OperationRow key={operation.id} operation={operation} />
            ))}
          </List>
        )}
      </Section>
      {snapshot?.cloud && (
        <Section title="Cloud connection">
          <div className="flex items-center gap-3">
            <StatusBadge
              tone={
                snapshot.cloud.state === "connected"
                  ? "success"
                  : snapshot.cloud.state === "connecting"
                    ? "running"
                    : snapshot.cloud.state === "unavailable"
                      ? "danger"
                      : "idle"
              }
              label={
                {
                  connected: "Connected",
                  connecting: "Connecting",
                  unavailable: "Unavailable",
                  unconfigured: "Local only",
                }[snapshot.cloud.state]
              }
            />
            {snapshot.cloud.message && (
              <span className="text-muted-foreground">{snapshot.cloud.message}</span>
            )}
          </div>
        </Section>
      )}
    </Page>
  );
}

function OperationRow({ operation }: { operation: Operation }) {
  const { submit } = useStateApi();
  const preparation = preparationCommands.includes(operation.command);
  const migration =
    (operation.command === "migration.analyze" || operation.command === "migration.publish") &&
    operation.status === "succeeded";
  return (
    <Row
      title={commandLabels[operation.command] ?? operation.command}
      detail={
        <>
          <span className="text-foreground/80" data-selectable>
            {operation.message}
          </span>
          <Mono className="ml-2">{operation.id}</Mono>
        </>
      }
      trailing={
        <>
          <OperationStatus status={operation.status} />
          {operation.command === "runner.run" && operation.status === "action_required" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submit({ type: "runner.reconcile", id: operation.id })}
            >
              Reconcile runner
            </Button>
          )}
          {cancellableCommands.includes(operation.command) && operation.status === "running" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void submit({ type: "operation.cancel", id: operation.id })}
            >
              Cancel
            </Button>
          )}
        </>
      }
    >
      {preparation && (
        <PreparationResult
          result={operation.result}
          macos={operation.command.includes("macos")}
          windows={operation.command.includes("windows")}
          resumable={operation.status === "action_required"}
        />
      )}
      {migration && <MigrationResult result={operation.result} />}
    </Row>
  );
}
