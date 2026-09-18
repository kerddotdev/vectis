import { useEffect, useState } from "react";
import { Schema } from "effect";
import { CircleHelpIcon, RefreshCwIcon } from "lucide-react";
import { Diagnostics as DiagnosticsReport } from "../../../../../packages/protocol/src/diagnostics.js";
import { StorageReport, type StorageUsage } from "../../../../../packages/protocol/src/storage.js";
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
} from "@/components/layout";
import { OsTile } from "@/components/os-icon";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, formatMemory, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStateApi } from "@/state";

function useMeasurement<T>(
  cache: Map<string, T>,
  action: "storage" | "doctor",
  decode: (value: unknown) => T,
) {
  const { perform, machineId } = useStateApi();
  const key = machineId ?? "local";
  const [report, setReport] = useState<T | null>(() => cache.get(key) ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function measure() {
    setPending(true);
    setError("");
    try {
      const value = await perform(action);
      if (value === undefined) return;
      const decoded = decode(value);
      cache.set(key, decoded);
      setReport(decoded);
    } catch {
      setError("The service returned a report this app cannot read.");
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void measure();
  }, []);
  return { report, pending, error, measure };
}

const storageCache = new Map<string, StorageReport>();
const diagnosticsCache = new Map<string, DiagnosticsReport>();

function RefreshButton({
  pending,
  onClick,
  label,
  pendingLabel,
}: {
  pending: boolean;
  onClick: () => void;
  label: string;
  pendingLabel: string;
}) {
  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={onClick}>
      <RefreshCwIcon className={cn(pending && "animate-spin")} />
      {pending ? pendingLabel : label}
    </Button>
  );
}

const allocated = (usage: StorageUsage) => usage.allocatedBytes ?? 0;

export function Storage() {
  const { snapshot } = useStateApi();
  const { report, pending, error, measure } = useMeasurement(
    storageCache,
    "storage",
    Schema.decodeUnknownSync(StorageReport),
  );
  const totals = (report?.environments ?? []).map((environment) => ({
    environment,
    bytes:
      allocated(environment.base) +
      environment.instances.reduce((sum, instance) => sum + allocated(instance.usage), 0),
  }));
  const total = totals.reduce((sum, item) => sum + item.bytes, 0);
  const largest = Math.max(1, ...totals.map((item) => item.bytes));
  return (
    <Page
      title="Storage"
      description="Space used by guest images and the virtual machine disks cloned from them."
      actions={
        <RefreshButton
          pending={pending}
          onClick={() => void measure()}
          label="Measure again"
          pendingLabel="Measuring"
        />
      }
    >
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!report ? (
        !error && <EmptyState>Measuring storage on this machine</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3">
            <StatCard label="Used on disk" value={formatBytes(total)} />
            <StatCard
              label="Environments"
              value={report.environments.length}
              detail={`${report.environments.reduce((sum, item) => sum + item.instances.length, 0)} VM disks`}
            />
            <StatCard label="Measured" value={formatRelative(report.measuredAt)} />
          </div>
          <Section title="By environment" description={report.allocationNote}>
            {!totals.length ? (
              <EmptyState>No environments have been prepared on this machine.</EmptyState>
            ) : (
              <List>
                {totals.map(({ environment, bytes }) => {
                  const details = snapshot?.environments.find(
                    (item) => item.id === environment.environmentId,
                  );
                  return (
                    <ExpandableRow
                      key={environment.environmentId}
                      leading={details && <OsTile os={details.os} />}
                      title={details?.name ?? environment.environmentId}
                      summary={`Base image and ${environment.instances.length} VM ${environment.instances.length === 1 ? "disk" : "disks"}`}
                      aside={
                        <span className="flex w-40 flex-col items-end gap-1.5">
                          <span className="text-sm font-medium tabular-nums">
                            {formatBytes(bytes)}
                          </span>
                          <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full origin-left rounded-full bg-brand/70"
                              style={{ transform: `scaleX(${bytes / largest})` }}
                            />
                          </span>
                        </span>
                      }
                    >
                      <div className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-border">
                        {[
                          { id: "Base image", usage: environment.base },
                          ...environment.instances.map((instance) => ({
                            id: `VM ${instance.id}`,
                            usage: instance.usage,
                          })),
                        ].map((item) => (
                          <UsageRow key={item.id} name={item.id} usage={item.usage} />
                        ))}
                      </div>
                    </ExpandableRow>
                  );
                })}
              </List>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}

function UsageRow({ name, usage }: { name: string; usage: StorageUsage }) {
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="truncate font-medium">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{formatBytes(usage.allocatedBytes)}</span>{" "}
          on disk
          {usage.virtualCapacityBytes !== undefined &&
            ` · ${formatBytes(usage.virtualCapacityBytes)} capacity`}
        </span>
      </div>
      <Details
        items={[
          ["Path", <Mono key="path">{usage.path}</Mono>],
          ["File size", usage.fileBytes !== undefined && formatBytes(usage.fileBytes)],
          ["Note", usage.reason],
        ]}
      />
      {!!usage.entries?.length && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          {usage.entries.map((entry) => (
            <div key={entry.name} className="flex justify-between gap-4 text-xs">
              <Mono>{entry.name}</Mono>
              <span className="tabular-nums">{formatBytes(entry.allocatedBytes)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const platforms: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const architectures: Record<string, string> = {
  arm64: "Apple Silicon (ARM64)",
  x64: "Intel (x86-64)",
};

const components = [
  {
    key: "appleHelper",
    name: "Apple Virtualization Helper",
    purpose: "Runs macOS and Ubuntu guests with Apple's Virtualization framework.",
  },
  {
    key: "keychainHelper",
    name: "Keychain Helper",
    purpose: "Stores machine and sign-in credentials in the macOS Keychain.",
  },
  { key: "qemu", name: "QEMU", purpose: "Runs Windows guests." },
  {
    key: "qemuImg",
    name: "QEMU Disk Tool",
    purpose: "Converts and clones disk images for Ubuntu and Windows guests.",
  },
  {
    key: "swtpm",
    name: "Software TPM",
    purpose: "Provides the TPM that Windows 11 requires.",
  },
] as const;

export function Diagnostics() {
  const { perform } = useStateApi();
  const [help, setHelp] = useState(false);
  const { report, pending, error, measure } = useMeasurement(
    diagnosticsCache,
    "doctor",
    Schema.decodeUnknownSync(DiagnosticsReport),
  );
  const missing = report ? components.filter(({ key }) => !report.configured[key]).length : 0;
  return (
    <Page
      title="Diagnostics"
      description="Whether this machine can run guests, and which runtime components the service found."
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <CircleHelpIcon />
            Help
          </Button>
          <RefreshButton
            pending={pending}
            onClick={() => void measure()}
            label="Check again"
            pendingLabel="Checking"
          />
        </>
      }
    >
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!report ? (
        !error && <EmptyState>Checking this machine</EmptyState>
      ) : (
        <>
          <Section title="Host">
            <List>
              <Row
                title={`${platforms[report.host.platform] ?? report.host.platform} on ${architectures[report.host.arch] ?? report.host.arch}`}
                detail={`${report.host.cpus} CPU cores · ${formatMemory(report.host.memoryMiB)} memory`}
                trailing={
                  <StatusBadge
                    tone={report.supportedHost ? "success" : "unsupported"}
                    label={report.supportedHost ? "Supported" : "Unsupported"}
                  />
                }
              />
            </List>
          </Section>
          <Section
            title="Runtime components"
            description={
              missing
                ? `${missing} of ${components.length} components are not configured. Guests that need them cannot start.`
                : "All components are configured. Each is checked again before a VM starts."
            }
          >
            <List>
              {components.map(({ key, name, purpose }) => (
                <Row
                  key={key}
                  title={name}
                  detail={purpose}
                  trailing={
                    <StatusBadge
                      tone={report.configured[key] ? "success" : "idle"}
                      label={report.configured[key] ? "Configured" : "Not configured"}
                    />
                  }
                />
              ))}
            </List>
            {missing > 0 && (
              <Button variant="link" className="self-start px-0" onClick={() => setHelp(true)}>
                How to configure missing components
              </Button>
            )}
          </Section>
          <Section title="Service data">
            <Details items={[["State directory", <Mono key="home">{report.home}</Mono>]]} />
          </Section>
        </>
      )}
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Runtime components</DialogTitle>
            <DialogDescription>
              Vectis uses small native programs to run guests and keep credentials safe.
            </DialogDescription>
          </DialogHeader>
          <div
            className="flex flex-col gap-4 leading-relaxed text-muted-foreground"
            data-selectable
          >
            <p>
              <span className="font-medium text-foreground">In the Vectis app</span>, every
              component ships inside the app and is configured automatically. If one shows Not
              configured, choose Use this app's runtime from the service menu in Overview.
            </p>
            <p>
              <span className="font-medium text-foreground">When running from source</span>, build
              the native helpers and set their absolute paths before starting the service:{" "}
              <Mono className="text-foreground">VECTIS_APPLE_HELPER</Mono>,{" "}
              <Mono className="text-foreground">VECTIS_KEYCHAIN_HELPER</Mono>,{" "}
              <Mono className="text-foreground">VECTIS_QEMU</Mono>,{" "}
              <Mono className="text-foreground">VECTIS_QEMU_IMG</Mono> and{" "}
              <Mono className="text-foreground">VECTIS_SWTPM</Mono>. Restart the service afterwards.
            </p>
            <ul className="flex flex-col gap-1.5">
              <li>
                <span className="text-foreground">macOS guests</span> need the Apple Virtualization
                Helper.
              </li>
              <li>
                <span className="text-foreground">Ubuntu guests</span> need the Apple Virtualization
                Helper and the QEMU Disk Tool.
              </li>
              <li>
                <span className="text-foreground">Windows guests</span> need QEMU, the QEMU Disk
                Tool and Software TPM.
              </li>
              <li>
                <span className="text-foreground">Pairing and remote control</span> need the
                Keychain Helper.
              </li>
            </ul>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => void perform("open.docs")}>
              Open documentation
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
