import { useState } from "react";
import { EllipsisIcon, PlayIcon, PlusIcon } from "lucide-react";
import type { Environment } from "../../../../../packages/protocol/src/index.js";
import { osNames } from "@vectis/design/os-icons";
import {
  Details,
  EmptyState,
  ExpandableRow,
  List,
  Mono,
  Notice,
  Page,
  Section,
} from "@/components/layout";
import { Reason, Resources } from "@/components/hint";
import { OsTile } from "@/components/os-icon";
import { formatMemory } from "@/lib/format";
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

export function Environments() {
  const { snapshot, machineId } = useStateApi();
  const [adding, setAdding] = useState(false);
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
              <PrepareEnvironment onDone={() => setAdding(false)} />
            </TabsContent>
            <TabsContent value="register">
              <RegisterEnvironment onDone={() => setAdding(false)} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function EnvironmentRow({ environment }: { environment: Environment }) {
  const { submit, snapshot } = useStateApi();
  const [configuring, setConfiguring] = useState(false);
  const running = snapshot?.instances.filter(
    (instance) => instance.environmentId === environment.id && instance.status === "running",
  ).length;
  return (
    <ExpandableRow
      leading={<OsTile os={environment.os} />}
      title={environment.name}
      summary={
        <span className="inline-flex items-center gap-3">
          <Resources cpu={environment.cpu} memoryMiB={environment.memoryMiB} />
          {!!running && <span>{running} running</span>}
        </span>
      }
      actions={
        <>
          <StatusBadge
            tone={environment.state === "ready" ? "success" : "attention"}
            label={environment.state === "ready" ? "Ready" : "Action required"}
          />
          <Reason
            reason={
              environment.state !== "ready" &&
              "Finish preparing this environment first. Its next step is in Overview."
            }
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={environment.state !== "ready"}
              onClick={() => void submit({ type: "environment.start", id: environment.id })}
            >
              <PlayIcon />
              Start clean VM
            </Button>
          </Reason>
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
    >
      <Details
        items={[
          ["Guest", osNames[environment.os]],
          ["CPU cores", environment.cpu],
          ["Memory", `${formatMemory(environment.memoryMiB)} (${environment.memoryMiB} MiB)`],
          ["Environment ID", <Mono key="id">{environment.id}</Mono>],
          ["Base image", <Mono key="base">{environment.basePath}</Mono>],
          [
            "VM directory",
            environment.storagePath ? <Mono>{environment.storagePath}</Mono> : "Service default",
          ],
          [
            "SSH",
            environment.sshHost && (
              <Mono>{`${environment.sshUser ? `${environment.sshUser}@` : ""}${environment.sshHost}:${environment.sshPort ?? 22}`}</Mono>
            ),
          ],
          ["SSH key", environment.sshKeyPath && <Mono>{environment.sshKeyPath}</Mono>],
          ["Firmware", environment.firmwarePath && <Mono>{environment.firmwarePath}</Mono>],
          ["TPM state", environment.tpmStatePath && <Mono>{environment.tpmStatePath}</Mono>],
        ]}
      />
    </ExpandableRow>
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
