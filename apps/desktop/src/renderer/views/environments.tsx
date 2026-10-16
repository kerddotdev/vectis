import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { EllipsisIcon, PlayIcon, PlusIcon } from "lucide-react";
import type { Egress } from "../../../../../packages/protocol/src/index.js";
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
import { formatDateTime, formatMemory } from "@/lib/format";
import {
  derivedImageDirectory,
  isPoolInstance,
  setupScriptLimitBytes,
  setupScriptTooLarge,
} from "@/lib/vm-capacity";
import {
  canRestrictNetwork,
  initialDraft,
  networkChanges,
  networkDisplay,
  type EnvironmentView,
} from "@/lib/environment-network";
import { PathField } from "@/components/path-field";
import { StatusBadge, StatusText } from "@/components/status";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStateApi } from "@/state";
import { PrepareEnvironment, RegisterEnvironment, TextField } from "./prepare-environment";

export function Environments() {
  const { snapshot, machineId } = useStateApi();
  const [adding, setAdding] = useState(false);
  const { add } = useSearch({ from: "/environments" });
  const navigate = useNavigate();
  useEffect(() => {
    if (!add) return;
    setAdding(true);
    void navigate({ to: "/environments", search: {}, replace: true });
  }, [add]);
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

function EnvironmentRow({ environment }: { environment: EnvironmentView }) {
  const network = networkDisplay(environment);
  const { submit, snapshot } = useStateApi();
  const [configuring, setConfiguring] = useState(false);
  const [deriving, setDeriving] = useState(false);
  const active = (snapshot?.instances ?? []).filter(
    (instance) =>
      instance.environmentId === environment.id &&
      (instance.status === "starting" || instance.status === "running"),
  );
  const warm = active.filter(isPoolInstance).length;
  const running = active.length - warm;
  const parentId = environment.image?.parentId;
  const parentName = snapshot?.environments.find((item) => item.id === parentId)?.name;
  const parent = parentName ?? parentId;
  return (
    <ExpandableRow
      id={environment.id}
      leading={<OsTile os={environment.os} />}
      title={environment.name}
      summary={
        <span className="inline-flex items-center gap-3">
          <Resources cpu={environment.cpu} memoryMiB={environment.memoryMiB} />
          {!!running && <span>{running} running</span>}
          {!!warm && <span>{warm} warm</span>}
          {parent && <span>Derived from {parent}</span>}
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
              "Finish preparing this environment first. Its next step is in Activity."
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
              <DropdownMenuItem
                disabled={environment.state !== "ready"}
                onClick={() => setDeriving(true)}
              >
                Create derived environment…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DeriveEnvironment parent={environment} open={deriving} onOpenChange={setDeriving} />
          <ConfigureEnvironment
            environment={environment}
            open={configuring}
            onOpenChange={setConfiguring}
          />
        </>
      }
    >
      <WarmPoolField environment={environment} />
      <Details
        items={[
          ["Guest", osNames[environment.os]],
          ["CPU cores", environment.cpu],
          ["Memory", `${formatMemory(environment.memoryMiB)} (${environment.memoryMiB} MiB)`],
          ["Network", network && <StatusText key="network" {...network} />],
          [
            "x86_64 tools",
            environment.os === "linux" && (environment.x64 === "rosetta" ? "Rosetta on" : "Off"),
          ],
          ["Environment ID", <Mono key="id">{environment.id}</Mono>],
          [
            "Derived from",
            parentId &&
              (parentName ? (
                <span key="parent">
                  {parentName} <Mono>{parentId}</Mono>
                </span>
              ) : (
                <Mono key="parent">{parentId}</Mono>
              )),
          ],
          [
            "Runner",
            environment.image &&
              (environment.image.runnerVersion
                ? `Preinstalled, version ${environment.image.runnerVersion}`
                : "Not preinstalled"),
          ],
          ["Provisioned", environment.image && formatDateTime(environment.image.provisionedAt)],
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

const egressItems: ReadonlyArray<{ value: Egress; label: string }> = [
  { value: "internet_only", label: "Internet only (recommended)" },
  { value: "open", label: "Open network access" },
];

function ConfigureEnvironment({
  environment,
  open,
  onOpenChange,
}: {
  environment: EnvironmentView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { submit } = useStateApi();
  const [cpu, setCpu] = useState(environment.cpu);
  const [memoryMiB, setMemory] = useState(environment.memoryMiB);
  const [storagePath, setStorage] = useState(environment.storagePath ?? "");
  const [draft, setDraft] = useState(() => initialDraft(environment));
  const network = networkDisplay(environment);
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
              ...networkChanges(environment, draft),
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
            {environment.os === "linux" && (
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor={`${environment.id}-rosetta`}>
                    Run x86_64 Linux tools with Rosetta
                  </FieldLabel>
                  <FieldDescription>
                    Lets jobs run x86_64 binaries and linux/amd64 containers. The runner stays
                    ARM64. Requires Rosetta on this Mac and a freshly prepared image.
                  </FieldDescription>
                </div>
                <Switch
                  id={`${environment.id}-rosetta`}
                  checked={draft.rosetta}
                  onCheckedChange={(rosetta) => setDraft({ ...draft, rosetta })}
                />
              </Field>
            )}
            {canRestrictNetwork(environment.os) ? (
              <Field>
                <FieldLabel htmlFor={`${environment.id}-egress`}>Network</FieldLabel>
                <Select
                  value={draft.egress}
                  onValueChange={(egress: Egress | null) =>
                    egress && setDraft({ ...draft, egress })
                  }
                  items={egressItems}
                >
                  <SelectTrigger id={`${environment.id}-egress`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {egressItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Internet only blocks the host and local network from the guest.
                </FieldDescription>
                {draft.egress === "open" && (
                  <p className="text-xs text-attention">
                    Jobs in this environment can reach this Mac and your local network.
                  </p>
                )}
              </Field>
            ) : (
              <Field>
                <div className="flex items-center justify-between gap-3 text-sm font-medium">
                  Network
                  {network && <StatusBadge {...network} />}
                </div>
                <FieldDescription>
                  Apple Virtualization cannot restrict guest network access yet. Jobs can reach this
                  Mac and your local network.
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit">Save for future VMs</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const warmPoolSizes = ["0", "1", "2", "3", "4"] as const;

function WarmPoolField({ environment }: { environment: EnvironmentView }) {
  const { submit } = useStateApi();
  const saved = environment.warmPool ?? 0;
  const [pending, setPending] = useState<number>();
  const ready = environment.state === "ready";
  const change = async (warmPool: number) => {
    setPending(warmPool);
    await submit(
      { type: "environment.configure", id: environment.id, warmPool },
      warmPool
        ? `Warm pool for ${environment.name} set to ${warmPool}`
        : `Warm pool for ${environment.name} turned off`,
    );
    setPending(undefined);
  };
  const label = `${environment.id}-warm-pool`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <p id={label} className="text-sm font-medium">
          Warm pool
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Keeps booted VMs waiting so jobs start faster. Each warm VM uses memory while idle and
          never holds job credentials.
        </p>
      </div>
      <Tabs
        value={String(pending ?? saved)}
        onValueChange={(value: string) => {
          const size = Number(value);
          if (size !== (pending ?? saved)) void change(size);
        }}
      >
        <TabsList aria-labelledby={label}>
          {warmPoolSizes.map((size) => (
            <TabsTrigger
              key={size}
              value={size}
              className="w-9 tabular-nums"
              disabled={!ready || pending !== undefined}
              aria-label={size === "0" ? "Off" : `${size} warm ${size === "1" ? "VM" : "VMs"}`}
            >
              {size === "0" ? "Off" : size}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

function DeriveEnvironment({
  parent,
  open,
  onOpenChange,
}: {
  parent: EnvironmentView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create derived environment</DialogTitle>
          <DialogDescription>
            Starts from a copy of {parent.name} and saves the result as a new environment.{" "}
            {parent.name} itself does not change.
            {parent.os === "windows" &&
              " Windows also gets Git with GNU tar, zstd, PowerShell 7 and a Defender policy exclusion."}{" "}
            Other VMs must be stopped while it is provisioned.
          </DialogDescription>
        </DialogHeader>
        <DeriveEnvironmentForm parent={parent} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DeriveEnvironmentForm({
  parent,
  onDone,
}: {
  parent: EnvironmentView;
  onDone: () => void;
}) {
  const { submit } = useStateApi();
  const [id, setId] = useState(`${parent.id}-custom`);
  const [imageDirectory, setImageDirectory] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [runner, setRunner] = useState(true);
  const [pending, setPending] = useState(false);
  const tooLarge = setupScriptTooLarge(setupScript);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (tooLarge) return;
        const data = new FormData(event.currentTarget);
        const name = String(data.get("name") ?? "").trim();
        setPending(true);
        void submit({
          type: "environment.provision",
          id,
          from: parent.id,
          imageDirectory,
          runner,
          ...(name ? { name } : {}),
          ...(setupScript.trim() ? { setupScript } : {}),
        })
          .then((value) => value !== undefined && onDone())
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="contents">
        <FieldGroup className="gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor={`${parent.id}-derived-id`}>Environment ID</FieldLabel>
              <Input
                id={`${parent.id}-derived-id`}
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}"
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
            </Field>
            <TextField label="Name" name="name" defaultValue={`${parent.name} (custom)`} required />
          </div>
          <PathField
            label="Image directory"
            chooser="chooseDirectory"
            required
            value={imageDirectory}
            onChange={setImageDirectory}
            fromChooser={(picked) => derivedImageDirectory(picked, id)}
            description="A new folder for the image. Choosing a folder adds the environment ID as a new folder inside it."
          />
          <Field>
            <FieldLabel htmlFor={`${parent.id}-setup-script`}>Setup script (optional)</FieldLabel>
            <textarea
              id={`${parent.id}-setup-script`}
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              rows={6}
              spellCheck={false}
              aria-invalid={tooLarge || undefined}
              placeholder="# Commands to run once in the guest"
              className="min-h-24 w-full resize-y rounded-2xl border border-input bg-input/30 px-3 py-2 font-mono text-[12px] transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20"
            />
            <FieldDescription>
              {tooLarge
                ? `The script is larger than ${setupScriptLimitBytes / 1024} KiB.`
                : `Runs once inside the guest with ${parent.os === "windows" ? "Windows PowerShell" : "bash"}. If it fails, no environment is created.`}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel htmlFor={`${parent.id}-derived-runner`}>Preinstall runner</FieldLabel>
              <FieldDescription>
                Installs the GitHub Actions runner version this Vectis release uses, so jobs skip
                the download.
              </FieldDescription>
            </div>
            <Switch
              id={`${parent.id}-derived-runner`}
              checked={runner}
              onCheckedChange={setRunner}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end">
          <Button type="submit" disabled={tooLarge}>
            Create environment
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
