import { useEffect, useState } from "react";
import { Schema } from "effect";
import { ChevronRightIcon, EllipsisIcon, PlayIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import { EmptyState, List, Notice, Page, Row, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { useStateApi } from "@/state";
import { ConnectRepository } from "./connect-repository";
import { RepositoryJobs } from "./repository-jobs";

export function Repositories() {
  const { perform, submit, snapshot } = useStateApi();
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
    if (snapshot) void discover();
  }, [!!snapshot]);
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh repositories"
            disabled={loading}
            onClick={() => void discover()}
          >
            <RefreshCwIcon />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConnecting(true)}>
            <PlusIcon />
            Connect repository
          </Button>
        </>
      }
    >
      {message && <Notice>{message}</Notice>}
      <Section title="Connected repositories">
        {!repositories ? (
          <EmptyState>
            {loading ? "Checking repository access" : "Repositories are unavailable."}
          </EmptyState>
        ) : repositories.length === 0 ? (
          <EmptyState>No repositories are connected to this machine.</EmptyState>
        ) : (
          <List>
            {repositories.map((repository) => (
              <Row
                key={repository.id}
                title={repository.repositoryName}
                detail={`Runs in ${
                  snapshot?.environments.find(
                    (environment) => environment.id === repository.environmentId,
                  )?.name ?? repository.environmentId
                }`}
                trailing={
                  <>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={starting !== null || !snapshot || snapshot.machine.paused}
                      onClick={() => void startRunner(repository.id)}
                    >
                      <PlayIcon />
                      {starting === repository.id ? "Requesting" : "Start runner"}
                    </Button>
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
                <Collapsible>
                  <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                    <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
                    GitHub jobs
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3">
                    <RepositoryJobs bindingId={repository.id} />
                  </CollapsibleContent>
                </Collapsible>
              </Row>
            ))}
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
