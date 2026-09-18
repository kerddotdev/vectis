import { useState } from "react";
import { EllipsisIcon, PlayIcon, PlusIcon } from "lucide-react";
import type { Environment } from "../../../../../packages/protocol/src/index.js";
import { EmptyState, List, Mono, Notice, Page, Row, Section } from "@/components/layout";
import { PathField } from "@/components/path-field";
import { StatusBadge } from "@/components/status";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStateApi } from "@/state";
import { PrepareEnvironment, RegisterEnvironment } from "./prepare-environment";

const osLabels = { linux: "lnx", macos: "mac", windows: "win" } as const;

export function Environments() {
  const { snapshot, machineId } = useStateApi();
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <Page
      title="Environments"
      description="Prepared guest images. Every job starts from a clean copy of one."
      actions={
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add environment
        </Button>
      }
    >
      {machineId && <Notice>File paths refer to the selected remote machine.</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      <Section title="Guest images">
        {!snapshot?.environments.length ? (
          <EmptyState>
            No environments yet. Add one to prepare Ubuntu, macOS or Windows for your jobs.
          </EmptyState>
        ) : (
          <List>
            {snapshot.environments.map((environment) => (
              <EnvironmentRow key={environment.id} environment={environment} />
            ))}
          </List>
        )}
      </Section>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add environment</DialogTitle>
            <DialogDescription>
              Prepare a new guest image, or register one you already have.
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="prepare">
            <TabsList variant="line" className="mb-4">
              <TabsTrigger value="prepare">Prepare new</TabsTrigger>
              <TabsTrigger value="register">Register existing</TabsTrigger>
            </TabsList>
            <TabsContent value="prepare">
              <PrepareEnvironment
                onDone={() => {
                  setAdding(false);
                  setMessage("Preparation requested. Follow, cancel or resume it in Overview.");
                }}
              />
            </TabsContent>
            <TabsContent value="register">
              <RegisterEnvironment
                onDone={() => {
                  setAdding(false);
                  setMessage("Registration requested. The environment appears here when ready.");
                }}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function EnvironmentRow({ environment }: { environment: Environment }) {
  const { submit } = useStateApi();
  const [configuring, setConfiguring] = useState(false);
  return (
    <Row
      leading={
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted font-mono text-[11px] text-muted-foreground">
          {osLabels[environment.os]}
        </span>
      }
      title={environment.name}
      detail={
        <>
          {environment.cpu} cores · {environment.memoryMiB} MiB ·{" "}
          <Mono>{environment.basePath}</Mono>
        </>
      }
      trailing={
        <>
          <StatusBadge
            tone={environment.state === "ready" ? "success" : "attention"}
            label={environment.state === "ready" ? "Ready" : "Action required"}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={environment.state !== "ready"}
            onClick={() => void submit({ type: "environment.start", id: environment.id })}
          >
            <PlayIcon />
            Start clean VM
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`${environment.name} actions`} />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setConfiguring(true)}>
                Resources and storage…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ConfigureEnvironment
            environment={environment}
            open={configuring}
            onOpenChange={setConfiguring}
          />
        </>
      }
    />
  );
}

function ConfigureEnvironment({
  environment,
  open,
  onOpenChange,
}: {
  environment: Environment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { submit } = useStateApi();
  const [cpu, setCpu] = useState(environment.cpu);
  const [memoryMiB, setMemory] = useState(environment.memoryMiB);
  const [storagePath, setStorage] = useState(environment.storagePath ?? "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{environment.name}</DialogTitle>
          <DialogDescription>Changes apply to VMs started from now on.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({
              type: "environment.configure",
              id: environment.id,
              cpu,
              memoryMiB,
              ...(storagePath ? { storagePath } : {}),
            }).then((value) => value !== undefined && onOpenChange(false));
          }}
        >
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor={`${environment.id}-cpu`}>CPU cores</FieldLabel>
                <Input
                  id={`${environment.id}-cpu`}
                  type="number"
                  required
                  min="1"
                  value={cpu}
                  onChange={(event) => setCpu(event.target.valueAsNumber)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${environment.id}-memory`}>Memory (MiB)</FieldLabel>
                <Input
                  id={`${environment.id}-memory`}
                  type="number"
                  required
                  min="512"
                  step="512"
                  value={memoryMiB}
                  onChange={(event) => setMemory(event.target.valueAsNumber)}
                />
              </Field>
            </div>
            <PathField
              label="VM directory"
              chooser="chooseDirectory"
              value={storagePath}
              onChange={setStorage}
              placeholder="Service default"
            />
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit">Save for future VMs</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
