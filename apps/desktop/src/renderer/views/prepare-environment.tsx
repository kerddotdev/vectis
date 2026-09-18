import { useState, type FormEvent } from "react";
import { Schema } from "effect";
import {
  Environment,
  LinuxPreparation,
  MacInstallation,
  WindowsInstallation,
} from "../../../../../packages/protocol/src/index.js";
import { Notice } from "@/components/layout";
import { PathField } from "@/components/path-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStateApi } from "@/state";

type GuestOs = "linux" | "macos" | "windows";
const defaults = {
  linux: {
    id: "ubuntu-24-arm64",
    name: "Ubuntu 24.04 ARM64",
    memoryMin: "2048",
    disk: "32",
    diskMin: "16",
  },
  macos: {
    id: "macos-26-arm64",
    name: "macOS 26 ARM64",
    memoryMin: "4096",
    disk: "64",
    diskMin: "40",
  },
  windows: {
    id: "windows-11-arm64",
    name: "Windows 11 ARM64",
    memoryMin: "4096",
    disk: "96",
    diskMin: "64",
  },
} as const;
const summaries = {
  linux:
    "Downloads verified Ubuntu 24.04 ARM64 and prepares SSH, Git, Docker and runner dependencies.",
  macos:
    "Downloads the verified macOS 26 image from Apple, or uses an existing IPSW. Setup Assistant and guest SSH configuration are separate steps; this does not register a ready runner.",
  windows:
    "Installs Windows 11 ARM64 from your official ISO with separate driver media, UEFI and TPM state. Activation and required licenses remain your responsibility.",
} as const;

export function NumberField({
  label,
  name,
  defaultValue,
  min,
  max,
  step,
}: {
  label: string;
  name: string;
  defaultValue: string;
  min: string;
  max?: string;
  step?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        id={name}
        name={name}
        type="number"
        required
        min={min}
        defaultValue={defaultValue}
        {...(max ? { max } : {})}
        {...(step ? { step } : {})}
      />
    </Field>
  );
}

export function TextField({
  label,
  name,
  defaultValue,
  required,
  pattern,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  pattern?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        id={name}
        name={name}
        {...(defaultValue ? { defaultValue } : {})}
        {...(required ? { required } : {})}
        {...(pattern ? { pattern } : {})}
      />
    </Field>
  );
}

export function PrepareEnvironment({ onDone }: { onDone: () => void }) {
  const [os, setOs] = useState<GuestOs>("linux");
  const { submit } = useStateApi();
  const [restorePath, setRestorePath] = useState("");
  const [imageDirectory, setImageDirectory] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [files, setFiles] = useState({
    isoPath: "",
    driversPath: "",
    firmwarePath: "",
    firmwareVarsPath: "",
  });
  const [acceptLicense, setAcceptLicense] = useState(false);
  const [issue, setIssue] = useState("");
  const [pending, setPending] = useState(false);
  const preset = defaults[os];
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const fields = {
        id: data.get("id"),
        name: data.get("name"),
        imageDirectory,
        storagePath,
        cpu: Number(data.get("cpu")),
        memoryMiB: Number(data.get("memoryMiB")),
        diskGiB: Number(data.get("diskGiB")),
      };
      const command =
        os === "linux"
          ? {
              type: "environment.prepare-linux" as const,
              ...Schema.decodeUnknownSync(LinuxPreparation)(fields),
            }
          : os === "windows"
            ? {
                type: "environment.install-windows" as const,
                ...Schema.decodeUnknownSync(WindowsInstallation)({
                  ...fields,
                  ...files,
                  imageName: data.get("imageName"),
                  acceptLicense,
                }),
              }
            : {
                type: "environment.install-macos" as const,
                ...Schema.decodeUnknownSync(MacInstallation)({
                  ...fields,
                  ...(restorePath ? { restorePath } : {}),
                }),
              };
      setPending(true);
      setIssue("");
      void submit(command)
        .then((value) => {
          if (value !== undefined) onDone();
        })
        .finally(() => setPending(false));
    } catch {
      setIssue("Check the identifier, directories and resource values.");
    }
  }
  return (
    <form onSubmit={prepare} className="flex flex-col gap-5">
      <Tabs value={os} onValueChange={(value: GuestOs) => setOs(value)}>
        <TabsList className="w-full">
          <TabsTrigger value="linux">Ubuntu 24.04</TabsTrigger>
          <TabsTrigger value="macos">macOS 26</TabsTrigger>
          <TabsTrigger value="windows">Windows 11</TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-muted-foreground">
        {summaries[os]} Other VMs must be stopped while an image is prepared.
      </p>
      <fieldset disabled={pending} key={os} className="contents">
        <FieldGroup className="gap-4">
          {os === "macos" && (
            <PathField
              label="Apple restore image (optional)"
              chooser="chooseRestoreImage"
              value={restorePath}
              onChange={setRestorePath}
              placeholder="Download the verified macOS 26 image"
            />
          )}
          {os === "windows" && (
            <>
              {(
                [
                  ["isoPath", "Windows ARM64 ISO"],
                  ["driversPath", "VirtIO driver ISO"],
                  ["firmwarePath", "ARM64 UEFI code"],
                  ["firmwareVarsPath", "Blank raw UEFI variables template"],
                ] as const
              ).map(([key, label]) => (
                <PathField
                  key={key}
                  label={label}
                  chooser="chooseFile"
                  required
                  value={files[key]}
                  onChange={(value) => setFiles((current) => ({ ...current, [key]: value }))}
                />
              ))}
              <TextField
                label="Windows image name"
                name="imageName"
                defaultValue="Windows 11 Pro"
                required
              />
            </>
          )}
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="Environment ID"
              name="id"
              defaultValue={preset.id}
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}"
            />
            <TextField label="Name" name="name" defaultValue={preset.name} required />
          </div>
          <PathField
            label="Base image directory"
            chooser="chooseDirectory"
            required
            value={imageDirectory}
            onChange={setImageDirectory}
          />
          <PathField
            label="Disposable VM directory"
            chooser="chooseDirectory"
            required
            value={storagePath}
            onChange={setStoragePath}
          />
          <div className="grid grid-cols-3 gap-4">
            <NumberField label="CPU cores" name="cpu" defaultValue="2" min="1" />
            <NumberField
              label="Memory (MiB)"
              name="memoryMiB"
              defaultValue="4096"
              min={preset.memoryMin}
              step="512"
            />
            <NumberField
              label="Disk (GiB)"
              name="diskGiB"
              defaultValue={preset.disk}
              min={preset.diskMin}
              max="2048"
            />
          </div>
          {os === "windows" && (
            <Field orientation="horizontal">
              <Checkbox
                id="accept-license"
                checked={acceptLicense}
                onCheckedChange={(checked) => setAcceptLicense(checked === true)}
              />
              <FieldLabel htmlFor="accept-license" className="font-normal">
                I accept the Windows license terms for this installation.
              </FieldLabel>
            </Field>
          )}
        </FieldGroup>
        {issue && (
          <Notice tone="danger" role="alert">
            {issue}
          </Notice>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={os === "windows" && !acceptLicense}>
            {os === "linux"
              ? "Prepare Linux environment"
              : os === "windows"
                ? "Install Windows"
                : "Install macOS"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function RegisterEnvironment({ onDone }: { onDone: () => void }) {
  const { submit, snapshot } = useStateApi();
  const [os, setOs] = useState<GuestOs>("linux");
  const [basePath, setBasePath] = useState("");
  const [storage, setStorage] = useState("");
  const [issue, setIssue] = useState("");
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssue("");
    const data = new FormData(event.currentTarget);
    const optional = (key: string) => (data.get(key) ? { [key]: data.get(key) } : {});
    try {
      const environment = Schema.decodeUnknownSync(Environment)({
        id: data.get("id"),
        name: data.get("name"),
        os,
        basePath,
        cpu: Number(data.get("cpu")),
        memoryMiB: Number(data.get("memoryMiB")),
        state: "ready",
        ...(storage ? { storagePath: storage } : {}),
        ...optional("sshUser"),
        ...optional("sshKeyPath"),
        ...optional("knownHostsPath"),
        ...optional("tpmStatePath"),
        ...optional("firmwarePath"),
        ...optional("firmwareVarsPath"),
      });
      if ((await submit({ type: "environment.register", environment })) !== undefined) onDone();
    } catch {
      setIssue("Check the environment identifier, OS, paths and resource values.");
    }
  }
  return (
    <form onSubmit={(event) => void register(event)} className="flex flex-col gap-5">
      <p className="text-muted-foreground">
        Use an existing Linux disk, macOS bundle or Windows image as the clean starting point.
      </p>
      <FieldGroup className="gap-4">
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Identifier"
            name="id"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}"
          />
          <TextField label="Name" name="name" required />
        </div>
        <Field>
          <FieldLabel>Operating system</FieldLabel>
          <Select
            value={os}
            onValueChange={(value: GuestOs | null) => value && setOs(value)}
            items={[
              { value: "linux", label: "Ubuntu Linux ARM64" },
              { value: "macos", label: "macOS ARM64" },
              { value: "windows", label: "Windows ARM64" },
            ]}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="linux">Ubuntu Linux ARM64</SelectItem>
              <SelectItem value="macos">macOS ARM64</SelectItem>
              <SelectItem value="windows">Windows ARM64</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <PathField
          label="Base image or bundle path"
          chooser="chooseFile"
          required
          value={basePath}
          onChange={setBasePath}
        />
        <div className="grid grid-cols-2 gap-4">
          <NumberField label="CPU cores" name="cpu" defaultValue="2" min="1" />
          <NumberField
            label="Memory (MiB)"
            name="memoryMiB"
            defaultValue="4096"
            min="512"
            step="512"
          />
        </div>
        <PathField
          label="VM storage directory"
          chooser="chooseDirectory"
          value={storage}
          onChange={setStorage}
          placeholder="Service default"
        />
        <Disclosure title="Guest SSH access">
          <FieldDescription>
            Provide guest-only credentials. The pinned host key entry must use the environment ID as
            its host alias. No host credentials are copied into the VM.
          </FieldDescription>
          <TextField label="Guest username" name="sshUser" />
          <TextField label="Guest SSH identity file" name="sshKeyPath" />
          <TextField label="Pinned known_hosts file" name="knownHostsPath" />
        </Disclosure>
        <Disclosure title="Windows firmware and TPM">
          <TextField label="Prepared TPM state directory" name="tpmStatePath" />
          <TextField label="UEFI code image" name="firmwarePath" />
          <TextField label="UEFI variable template" name="firmwareVarsPath" />
        </Disclosure>
      </FieldGroup>
      {issue && (
        <Notice tone="danger" role="alert">
          {issue}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button disabled={!snapshot} type="submit">
          Register image
        </Button>
      </div>
    </form>
  );
}

export function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Collapsible className="rounded-xl ring-1 ring-border">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2.5 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="flex flex-col gap-4 px-3 pb-3 data-closed:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
