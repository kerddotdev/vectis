import { useEffect, useState } from "react";
import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, PlayIcon, PlusIcon } from "lucide-react";
import {
  RepositoryReadiness,
  type ReadinessCheck,
} from "../../../../../packages/protocol/src/readiness.js";
import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import { GitHubIcon } from "@/components/github-icon";
import { Hint, Reason } from "@/components/hint";
import { EmptyState, ExpandableRow, List, Mono, Page, Section } from "@/components/layout";
import { OsIcon } from "@/components/os-icon";
import { ReadinessIndicator, ReadinessList } from "@/components/readiness";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { summarizeReadiness } from "@/lib/readiness";
import { request, useStateApi } from "@/state";
import { ConnectRepository } from "./connect-repository";
import { RepositoryJobs } from "./repository-jobs";

type Binding = MachineRepositories[number];

// Every check asks GitHub through the cloud, so results are shared across visits for a while and
// bindings are checked one at a time.
const readinessCache = new Map<string, { at: number; checks: readonly ReadinessCheck[] }>();
const readinessAge = 120_000;

function useBindingReadiness(bindingIds: readonly string[]) {
  const { machineId } = useStateApi();
  const scope = machineId ?? "local";
  const [, setVersion] = useState(0);
  const ids = bindingIds.join(",");
  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (const bindingId of bindingIds) {
        if (stopped) return;
        const key = `${scope}:${bindingId}`;
        const cached = readinessCache.get(key);
        if (cached && Date.now() - cached.at < readinessAge) continue;
        try {
          const { checks } = Schema.decodeUnknownSync(RepositoryReadiness)(
            await request("repository.readiness", { bindingId }, machineId),
          );
          // The automatic switch sits next to the binding, so its state is not a problem to report.
          readinessCache.set(key, {
            at: Date.now(),
            checks: checks.filter((check) => check.code !== "automatic_disabled"),
          });
          if (!stopped) setVersion((value) => value + 1);
        } catch {
          readinessCache.delete(key);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [scope, ids]);
  return (bindingId: string) => readinessCache.get(`${scope}:${bindingId}`)?.checks;
}

export function Repositories() {
  const { submit, snapshot, machineId } = useStateApi();
  const navigate = useNavigate();
  const linked = !!machineId || (!!snapshot?.cloud && snapshot.cloud.state !== "unconfigured");
  const repositories = snapshot?.repositories ?? null;
  const [starting, setStarting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  async function startRunner(bindingId: string) {
    setStarting(bindingId);
    try {
      await submit({ type: "runner.run", bindingId });
    } finally {
      setStarting(null);
    }
  }
  // One repository can run on several environments. GitHub sees one repository, so the page does
  // too, and the environments it runs on live inside it.
  const grouped = new Map<number, Binding[]>();
  for (const binding of repositories ?? [])
    grouped.set(binding.repositoryId, [...(grouped.get(binding.repositoryId) ?? []), binding]);
  const groups = [...grouped.values()].sort((left, right) =>
    (left[0]?.repositoryName ?? "").localeCompare(right[0]?.repositoryName ?? ""),
  );
  const readiness = useBindingReadiness((repositories ?? []).map((binding) => binding.id));
  return (
    <Page
      title="Repositories"
      description="Repositories whose jobs run on this machine. Build files stay here."
      actions={
        <Reason reason={!linked && "Connect this Mac to your Vectis account first."}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!linked}
            onClick={() => setConnecting(true)}
          >
            <PlusIcon />
            Connect repository
          </Button>
        </Reason>
      }
    >
      <Section title="Connected repositories">
        {snapshot && !linked ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl px-6 py-10 text-center ring-1 ring-border ring-inset">
            <p className="font-medium">Connect this Mac to run GitHub jobs</p>
            <p className="max-w-[48ch] text-muted-foreground">
              Repositories are linked through your Vectis account. Connect this Mac in Connections,
              link GitHub, then connect a repository here.
            </p>
            <Button size="sm" onClick={() => void navigate({ to: "/connections" })}>
              Open Connections
            </Button>
          </div>
        ) : !repositories ? (
          <EmptyState>Checking repository access</EmptyState>
        ) : groups.length === 0 ? (
          <EmptyState>No repositories are connected to this machine.</EmptyState>
        ) : (
          <List>
            {groups.map((bindings) => {
              const first = bindings[0];
              if (!first) return null;
              const automatic = bindings.filter((binding) => binding.automatic).length;
              const status = summarizeReadiness(
                bindings.flatMap((binding) => readiness(binding.id) ?? []),
              ).status;
              return (
                <ExpandableRow
                  key={first.repositoryId}
                  leading={
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/80">
                      <GitHubIcon className="size-[18px]" />
                    </span>
                  }
                  title={first.repositoryName}
                  aside={
                    <span className="text-xs">
                      <ReadinessIndicator status={status} />
                    </span>
                  }
                  summary={
                    <>
                      {bindings.length} {bindings.length === 1 ? "environment" : "environments"}
                      {automatic > 0 && ` · ${automatic} automatic`}
                    </>
                  }
                >
                  <Section
                    title="Environments"
                    hint={
                      <Hint label="About automatic runners">
                        When on, this Mac starts a runner by itself whenever GitHub queues a job for
                        this repository. Failed jobs are never retried automatically.
                      </Hint>
                    }
                  >
                    <div className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-border ring-inset">
                      {bindings.map((binding) => {
                        const environment = snapshot?.environments.find(
                          (item) => item.id === binding.environmentId,
                        );
                        const checks = readiness(binding.id);
                        return (
                          <div
                            key={binding.id}
                            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5"
                          >
                            {environment && <OsIcon os={environment.os} className="size-4" />}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {environment?.name ?? binding.environmentId}
                              </span>
                              {binding.runsOn && (
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                  {"runs-on: "}
                                  <Mono>{binding.runsOn}</Mono>
                                </span>
                              )}
                            </span>
                            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                              Automatic
                              <Switch
                                size="sm"
                                checked={!!binding.automatic}
                                onCheckedChange={(enabled) =>
                                  void submit(
                                    {
                                      type: "repository.automatic",
                                      bindingId: binding.id,
                                      enabled,
                                    },
                                    `Automatic runners ${enabled ? "on" : "off"} for ${first.repositoryName}`,
                                  )
                                }
                              />
                            </label>
                            <Reason
                              reason={
                                (!snapshot && "The service is not reachable.") ||
                                (snapshot?.machine.paused &&
                                  "New VMs are paused. Resume them in Overview.")
                              }
                            >
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={starting !== null || !snapshot || snapshot.machine.paused}
                                onClick={() => void startRunner(binding.id)}
                              >
                                <PlayIcon />
                                {starting === binding.id ? "Requesting" : "Start runner"}
                              </Button>
                            </Reason>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`${first.repositoryName} on ${environment?.name ?? binding.environmentId} actions`}
                                  />
                                }
                              >
                                <EllipsisIcon />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-60">
                                <DropdownMenuItem
                                  onClick={() =>
                                    void submit({
                                      type: "migration.analyze",
                                      bindingId: binding.id,
                                    })
                                  }
                                >
                                  Analyze workflow migration
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    void submit({
                                      type: "repository.disconnect",
                                      bindingId: binding.id,
                                    })
                                  }
                                >
                                  Disconnect from this environment
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {checks && summarizeReadiness(checks).status !== "ok" && (
                              <ReadinessList
                                checks={checks}
                                className="basis-full rounded-lg ring-1 ring-border ring-inset"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Section>
                  <RepositoryJobs bindingId={first.id} />
                </ExpandableRow>
              );
            })}
          </List>
        )}
      </Section>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect a repository</DialogTitle>
            <DialogDescription>
              Jobs from this repository will run in the environment you choose.
            </DialogDescription>
          </DialogHeader>
          <ConnectRepository onDone={() => setConnecting(false)} />
        </DialogContent>
      </Dialog>
    </Page>
  );
}
