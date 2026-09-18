import { useState } from "react";
import { Schema } from "effect";
import { ChevronRightIcon, GaugeIcon, StethoscopeIcon } from "lucide-react";
import { Diagnostics as DiagnosticsReport } from "../../../../../packages/protocol/src/diagnostics.js";
import { StorageReport } from "../../../../../packages/protocol/src/storage.js";
import { EmptyState, List, Mono, Notice, Page, Row, Section } from "@/components/layout";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useStateApi } from "@/state";

const size = (bytes: number | undefined) =>
  bytes === undefined ? "Unavailable" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function Storage() {
  const { perform } = useStateApi();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function measure() {
    setPending(true);
    try {
      const value = await perform("storage");
      if (value === undefined) return;
      setReport(Schema.decodeUnknownSync(StorageReport)(value));
      setError("");
    } catch {
      setError("Storage information could not be read.");
    } finally {
      setPending(false);
    }
  }
  return (
    <Page
      title="Storage"
      description="Base images, virtual machine disks and the host blocks they occupy."
      actions={
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => void measure()}>
          <GaugeIcon />
          {pending ? "Measuring" : "Measure storage"}
        </Button>
      }
    >
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!report && !error && (
        <EmptyState>Measure storage to see how much space each image uses.</EmptyState>
      )}
      {report && <p className="-mt-4 text-muted-foreground">{report.allocationNote}</p>}
      {report?.environments.map((environment) => (
        <Section
          key={environment.environmentId}
          title={environment.environmentId}
          description="Guest filesystem breakdown is not available yet."
        >
          <List>
            {[{ id: "Base image", usage: environment.base }, ...environment.instances].map(
              (item) => (
                <Row
                  key={item.id}
                  title={item.id}
                  detail={<Mono>{item.usage.path}</Mono>}
                  trailing={
                    <span className="text-right text-xs tabular-nums">
                      <span className="block font-medium text-foreground">
                        {size(item.usage.allocatedBytes)}
                      </span>
                      <span className="text-muted-foreground">
                        {size(item.usage.fileBytes)} file size
                      </span>
                    </span>
                  }
                >
                  {item.usage.reason && (
                    <p className="text-muted-foreground">{item.usage.reason}</p>
                  )}
                  {!!item.usage.entries?.length && (
                    <Collapsible>
                      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
                        Host file breakdown
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-2">
                        {item.usage.entries.map((entry) => (
                          <div key={entry.name} className="flex justify-between py-1 text-xs">
                            <Mono>{entry.name}</Mono>
                            <span className="tabular-nums">{size(entry.allocatedBytes)}</span>
                          </div>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </Row>
              ),
            )}
          </List>
        </Section>
      ))}
    </Page>
  );
}

const helpers = [
  ["appleHelper", "Apple virtualization helper"],
  ["qemu", "QEMU"],
  ["qemuImg", "qemu-img"],
  ["swtpm", "Software TPM"],
  ["keychainHelper", "Keychain helper"],
] as const;

export function Diagnostics() {
  const { perform } = useStateApi();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function inspect() {
    setPending(true);
    setError("");
    try {
      const value = await perform("doctor");
      if (value !== undefined) setReport(Schema.decodeUnknownSync(DiagnosticsReport)(value));
    } catch {
      setError("The service returned an invalid diagnostic report.");
    } finally {
      setPending(false);
    }
  }
  return (
    <Page
      title="Diagnostics"
      description="The running service's host and configured helpers."
      actions={
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => void inspect()}>
          <StethoscopeIcon />
          {pending ? "Inspecting" : "Inspect service"}
        </Button>
      }
    >
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!report && !error && <EmptyState>Inspect the service to check this host.</EmptyState>}
      {report && (
        <>
          <Section title="Host">
            <List>
              <Row
                title={`${report.host.platform} · ${report.host.arch}`}
                detail={`${report.host.cpus} cores · ${report.host.memoryMiB} MiB`}
                trailing={
                  <StatusBadge
                    tone={report.supportedHost ? "success" : "unsupported"}
                    label={report.supportedHost ? "Supported host" : "Unsupported host"}
                  />
                }
              />
            </List>
          </Section>
          <Section
            title="Runtime configuration"
            description="Configured paths still require a successful runtime check before a VM starts."
          >
            <List>
              {helpers.map(([name, label]) => (
                <Row
                  key={name}
                  title={label}
                  trailing={
                    <StatusBadge
                      tone={report.configured[name] ? "success" : "idle"}
                      label={report.configured[name] ? "Configured" : "Not configured"}
                    />
                  }
                />
              ))}
            </List>
          </Section>
          <Section title="Service state directory">
            <Mono className="text-foreground">{report.home}</Mono>
          </Section>
        </>
      )}
    </Page>
  );
}
