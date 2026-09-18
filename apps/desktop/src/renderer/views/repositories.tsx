import { useEffect, useState } from "react";
import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, PlayIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import { GitHubIcon } from "@/components/github-icon";
import { Hint, Reason } from "@/components/hint";
import { EmptyState, ExpandableRow, List, Notice, Page, Section } from "@/components/layout";
import { OsIcon } from "@/components/os-icon";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStateApi } from "@/state";
import { ConnectRepository } from "./connect-repository";
import { RepositoryJobs } from "./repository-jobs";

export function Repositories() {
  const { perform, submit, snapshot, machineId } = useStateApi();
  const navigate = useNavigate();
  const linked = !!machineId || (!!snapshot?.cloud && snapshot.cloud.state !== "unconfigured");
  const [repositories, setRepositories] = useState<MachineRepositories | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  async function discover() {
    setLoading(true);
    try {
      const result = await perform("repositories");
      if (result !== undefined)
        setRepositories(Schema.decodeUnknownSync(MachineRepositories)(result));
    } catch {
      setMessage("The service returned an invalid repository report.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (snapshot && linked) void discover();
  }, [!!snapshot, linked]);
  async function startRunner(bindingId: string) {
    setStarting(bindingId);
    try {
      if ((await submit({ type: "runner.run", bindingId })) !== undefined)
        setMessage("Runner requested. Follow its progress in Overview.");
    } finally {
      setStarting(null);
    }
  }
  return (
    <Page
      title="Repositories"
      description="Repositories whose jobs run on this machine. Build files stay here."
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh repositories"
                  disabled={loading || !linked}
                  onClick={() => void discover()}
                />
              }
            >
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>Refresh repositories</TooltipContent>
          </Tooltip>
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
        </>
      }
    >
      {message && <Notice>{message}</Notice>}
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
          <EmptyState>
            {loading ? "Checking repository access" : "Repositories are unavailable."}
          </EmptyState>
        ) : repositories.length === 0 ? (
          <EmptyState>No repositories are connected to this machine.</EmptyState>
        ) : (
          <List>
            {repositories.map((repository) => {
              const environment = snapshot?.environments.find(
                (item) => item.id === repository.environmentId,
              );
              return (
                <ExpandableRow
                  key={repository.id}
                  leading={
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/80">
                      <GitHubIcon className="size-[18px]" />
                    </span>
                  }
                  title={repository.repositoryName}
                  summary={
                    <span className="inline-flex items-center gap-1.5">
                      {environment && <OsIcon os={environment.os} className="size-3" />}
                      Runs in {environment?.name ?? repository.environmentId}
                    </span>
                  }
                  actions={
                    <>
                      <Hint label="About automatic runners">
                        When on, this Mac starts a runner by itself whenever GitHub queues a job for
                        this repository. Failed jobs are never retried automatically.
                      </Hint>
                      <label className="flex items-center gap-2 pr-1 text-xs text-muted-foreground">
                        Automatic
                        <Switch
                          size="sm"
                          checked={!!repository.automatic}
                          onCheckedChange={(enabled) =>
                            void submit({
                              type: "repository.automatic",
                              bindingId: repository.id,
                              enabled,
                            }).then((value) => {
                              if (value !== undefined)
                                setMessage(
                                  "Automatic mode change requested. Follow the operation in Overview, then refresh repositories.",
                                );
                            })
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
                          onClick={() => void startRunner(repository.id)}
                        >
                          <PlayIcon />
                          {starting === repository.id ? "Requesting" : "Start runner"}
                        </Button>
                      </Reason>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${repository.repositoryName} actions`}
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
                                bindingId: repository.id,
                              }).then((value) => {
                                if (value !== undefined)
                                  setMessage(
                                    "Migration analysis requested. The preview appears in Overview.",
                                  );
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
                                bindingId: repository.id,
                              }).then((value) => {
                                if (value !== undefined)
                                  setMessage(
                                    "Disconnection requested. Follow the operation in Overview, then refresh repositories. Running jobs can finish.",
                                  );
                              })
                            }
                          >
                            Disconnect repository
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                >
                  <RepositoryJobs bindingId={repository.id} />
                </ExpandableRow>
              );
            })}
          </List>
        )}
      </Section>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect a repository</DialogTitle>
            <DialogDescription>
              Jobs from this repository will run in the environment you choose.
            </DialogDescription>
          </DialogHeader>
          <ConnectRepository
            onDone={() => {
              setConnecting(false);
              setMessage(
                "Connection requested. Follow its operation in Overview, then refresh repositories.",
              );
            }}
          />
        </DialogContent>
      </Dialog>
    </Page>
  );
}
