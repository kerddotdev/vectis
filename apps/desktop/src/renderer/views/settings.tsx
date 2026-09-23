import { useEffect, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { defaultMaxRunners } from "../../../../../packages/protocol/src/index.js";
import { List, Page, Row, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatMemory } from "@/lib/format";
import { useStateApi } from "@/state";

const limits = { min: 1, max: 16 } as const;

export function Settings() {
  const { snapshot, submit } = useStateApi();
  const saved = snapshot?.machine.maxRunners ?? defaultMaxRunners;
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  const capacity = snapshot?.runnerCapacity;
  const largest = (snapshot?.environments ?? [])
    .filter((environment) => environment.state === "ready")
    .sort((left, right) => right.cpu - left.cpu || right.memoryMiB - left.memoryMiB)[0];
  const room = capacity ? capacity.active + capacity.available : undefined;
  const save = async () => {
    setSaving(true);
    await submit(
      { type: "machine.configure", maxRunners: value },
      `Up to ${value} VMs run at once`,
    );
    setSaving(false);
  };
  return (
    <Page title="Settings" description="How this machine takes on work.">
      <Section title="Runners">
        <List>
          <Row
            title="Concurrent VMs"
            detail="How many GitHub jobs this machine runs at the same time."
            trailing={
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Fewer VMs"
                  disabled={!snapshot || value <= limits.min}
                  onClick={() => setValue(value - 1)}
                >
                  <MinusIcon />
                </Button>
                <span className="w-6 text-center tabular-nums" aria-live="polite">
                  {value}
                </span>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="More VMs"
                  disabled={!snapshot || value >= limits.max}
                  onClick={() => setValue(value + 1)}
                >
                  <PlusIcon />
                </Button>
                <Button
                  size="sm"
                  className="ml-2"
                  disabled={value === saved || saving}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </div>
            }
          />
          {capacity &&
            !snapshot?.machine.paused &&
            room !== undefined &&
            room < capacity.max &&
            largest && (
              <Row
                title={`${room} of ${capacity.max} fit right now`}
                detail={`Your largest environment, ${largest.name}, uses ${largest.cpu} CPUs and ${formatMemory(largest.memoryMiB)}. Lower its CPU or memory to run more jobs at once.`}
              />
            )}
          <Row
            title="Take on new VMs"
            detail="When off, running jobs finish and nothing new starts."
            trailing={
              <Switch
                checked={!snapshot?.machine.paused}
                disabled={!snapshot}
                aria-label="Take on new VMs"
                onCheckedChange={(enabled) =>
                  void submit(
                    { type: "machine.pause", paused: !enabled },
                    enabled ? "New VMs resumed" : "New VMs paused",
                  )
                }
              />
            }
          />
        </List>
      </Section>
    </Page>
  );
}
