import { useEffect, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { defaultMaxRunners } from "../../../../../packages/protocol/src/index.js";
import { List, Page, Row, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusText } from "@/components/status";
import { formatMemory } from "@/lib/format";
import { notify } from "@/lib/notify";
import { getNotificationsEnabled, setNotificationsEnabled } from "@/lib/notification-preferences";
import {
  budgetLimits,
  committedShare,
  defaultBudgetMiB,
  pressureDisplay,
  stepBudget,
} from "@/lib/vm-capacity";
import { useStateApi } from "@/state";

const limits = { min: 1, max: 16 } as const;

export function Settings() {
  const { snapshot, submit, machineId } = useStateApi();
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
          <MemoryBudgetRow />
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
      {!machineId && <NotificationsSection />}
    </Page>
  );
}

function MemoryBudgetRow() {
  const { snapshot, submit } = useStateApi();
  const budget = snapshot?.runnerCapacity?.budget;
  const custom = snapshot?.machine.memoryBudgetMiB;
  const saved = budget?.memoryBudgetMiB;
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  if (!budget || value === undefined) return null;
  const { min, max } = budgetLimits(budget.hostMemoryMiB);
  const fallback = defaultBudgetMiB(budget.hostMemoryMiB);
  const pressure = pressureDisplay(budget);
  const save = async (memoryBudgetMiB: number, success: string) => {
    setSaving(true);
    await submit({ type: "machine.configure", memoryBudgetMiB }, success);
    setSaving(false);
  };
  return (
    <Row
      title="VM memory budget"
      detail="New VMs start only when their memory fits this budget and the Mac is not under memory pressure. Memory a VM does not use is not taken from the Mac, and VMs share CPU cores."
      trailing={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Lower memory budget"
            disabled={value <= min}
            onClick={() => setValue(stepBudget(value, -1, budget.hostMemoryMiB))}
          >
            <MinusIcon />
          </Button>
          <span className="w-14 text-center tabular-nums" aria-live="polite">
            {formatMemory(value)}
          </span>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Raise memory budget"
            disabled={value >= max}
            onClick={() => setValue(stepBudget(value, 1, budget.hostMemoryMiB))}
          >
            <PlusIcon />
          </Button>
          <Button
            size="sm"
            className="ml-2"
            disabled={value === saved || saving}
            onClick={() => void save(value, `VM memory budget set to ${formatMemory(value)}`)}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div
          role="meter"
          aria-label="Committed VM memory"
          aria-valuemin={0}
          aria-valuemax={budget.memoryBudgetMiB}
          aria-valuenow={Math.min(budget.memoryCommittedMiB, budget.memoryBudgetMiB)}
          aria-valuetext={`${formatMemory(Math.round(budget.memoryCommittedMiB))} of ${formatMemory(budget.memoryBudgetMiB)}`}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full origin-left rounded-full bg-running transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${committedShare(budget)})` }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {formatMemory(Math.round(budget.memoryCommittedMiB))} of{" "}
            {formatMemory(budget.memoryBudgetMiB)} committed to running VMs
          </span>
          <StatusText {...pressure} />
          <span className="tabular-nums">
            {custom === undefined
              ? `Default, 75% of ${formatMemory(Math.round(budget.hostMemoryMiB))}`
              : `Default is ${formatMemory(fallback)}`}
          </span>
          {custom !== undefined && custom !== fallback && (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0"
              disabled={saving}
              onClick={() =>
                void save(fallback, `VM memory budget reset to ${formatMemory(fallback)}`)
              }
            >
              Use default
            </Button>
          )}
        </div>
      </div>
    </Row>
  );
}

function NotificationsSection() {
  const [enabled, setEnabled] = useState<boolean>();
  useEffect(() => {
    let current = true;
    getNotificationsEnabled().then(
      (value) => current && setEnabled(value),
      (issue: unknown) =>
        notify.error(issue instanceof Error ? issue.message : "The request failed."),
    );
    return () => {
      current = false;
    };
  }, []);
  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      setEnabled(await setNotificationsEnabled(next));
    } catch (issue) {
      setEnabled(previous);
      notify.error(issue instanceof Error ? issue.message : "The request failed.");
    }
  };
  return (
    <Section title="Notifications">
      <List>
        <Row
          title="Notify me when Vectis needs me or work fails"
          detail="Shows a macOS notification while Vectis is open in the background. Notifications stop when you quit the app."
          trailing={
            <Switch
              checked={enabled ?? false}
              disabled={enabled === undefined}
              aria-label="Notify me when Vectis needs me or work fails"
              onCheckedChange={(next) => void change(next)}
            />
          }
        />
      </List>
    </Section>
  );
}
