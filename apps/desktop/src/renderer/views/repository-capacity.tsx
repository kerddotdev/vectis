import { useState } from "react";
import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import type { CapacityMode } from "../../../../../packages/protocol/src/scale-sets.js";
import { OsIcon } from "@/components/os-icon";
import { StatusText } from "@/components/status";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { capacityMode, scaleSetPresentation, scaleSetUnavailableReason } from "@/lib/capacity-mode";
import { useStateApi } from "@/state";

type Binding = MachineRepositories[number];

export function RepositoryCapacity({
  binding,
  repositoryName,
}: {
  binding: Binding;
  repositoryName: string;
}) {
  const { submit, snapshot } = useStateApi();
  const [pending, setPending] = useState<CapacityMode>();
  const environment = snapshot?.environments.find((item) => item.id === binding.environmentId);
  const label = environment?.name ?? binding.environmentId;
  const mode = pending ?? capacityMode(binding);
  const unavailable = scaleSetUnavailableReason(binding);
  const presentation =
    capacityMode(binding) === "scale_set"
      ? scaleSetPresentation(
          binding,
          snapshot?.scaleSets?.find((state) => state.bindingId === binding.id),
          !!snapshot?.machine.paused,
        )
      : undefined;
  async function change(next: CapacityMode) {
    setPending(next);
    try {
      await submit(
        { type: "repository.capacity-mode", bindingId: binding.id, mode: next },
        `${repositoryName} on ${label} now uses ${next === "scale_set" ? "a scale set" : "demand capacity"}`,
      );
    } finally {
      setPending(undefined);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
      {environment && <OsIcon os={environment.os} className="size-4" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {presentation ? (
            <>
              <StatusText tone={presentation.tone} label={presentation.label} />
              {presentation.detail && <span> · {presentation.detail}</span>}
            </>
          ) : (
            "A runner starts for each queued job."
          )}
        </span>
      </span>
      <Tabs
        value={mode}
        onValueChange={(value: CapacityMode) => {
          if (value !== mode) void change(value);
        }}
      >
        <TabsList aria-label={`Capacity for ${label}`}>
          <TabsTrigger value="demand" disabled={pending !== undefined}>
            Demand
          </TabsTrigger>
          <TabsTrigger value="scale_set" disabled={pending !== undefined || !!unavailable}>
            Scale set
            <span className="text-[11px] font-normal text-muted-foreground">Preview</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {unavailable && <p className="basis-full text-xs text-muted-foreground">{unavailable}</p>}
    </div>
  );
}
