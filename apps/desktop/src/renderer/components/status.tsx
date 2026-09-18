import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const tones = {
  queued: { icon: ClockIcon, className: "text-neutral bg-neutral/12" },
  running: { icon: CircleDotIcon, className: "text-running bg-running/12" },
  attention: { icon: TriangleAlertIcon, className: "text-attention bg-attention/12" },
  success: { icon: CircleCheckIcon, className: "text-success bg-success/12" },
  danger: { icon: CircleXIcon, className: "text-danger bg-danger/12" },
  cancelled: { icon: CircleSlashIcon, className: "text-neutral bg-neutral/12" },
  idle: { icon: CircleIcon, className: "text-neutral bg-neutral/12" },
  unsupported: {
    icon: CircleDashedIcon,
    className: "text-neutral ring-1 ring-inset ring-hairline-strong",
  },
} as const;

export type Tone = keyof typeof tones;

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  const { icon: Icon, className } = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs font-medium whitespace-nowrap",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

const operationStates = {
  accepted: ["queued", "Accepted"],
  running: ["running", "Running"],
  action_required: ["attention", "Action required"],
  succeeded: ["success", "Succeeded"],
  failed: ["danger", "Failed"],
  cancelled: ["cancelled", "Cancelled"],
} as const satisfies Record<string, readonly [Tone, string]>;

export function OperationStatus({ status }: { status: keyof typeof operationStates }) {
  const [tone, label] = operationStates[status];
  return <StatusBadge tone={tone} label={label} />;
}

const instanceStates = {
  running: ["running", "Running"],
  stopped: ["idle", "Stopped"],
  interrupted: ["attention", "Interrupted"],
} as const satisfies Record<string, readonly [Tone, string]>;

export function InstanceStatus({
  status,
  inline = false,
}: {
  status: keyof typeof instanceStates;
  inline?: boolean;
}) {
  const [tone, label] = instanceStates[status];
  return inline ? (
    <StatusText tone={tone} label={label} />
  ) : (
    <StatusBadge tone={tone} label={label} />
  );
}

export function StatusText({ tone, label }: { tone: Tone; label: string }) {
  const { icon: Icon, className } = tones[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 bg-transparent font-medium", className)}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

export function JobStatus({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== "completed")
    return status === "in_progress" ? (
      <StatusBadge tone="running" label="In progress" />
    ) : (
      <StatusBadge tone="queued" label="Queued" />
    );
  if (conclusion === "success") return <StatusBadge tone="success" label="Succeeded" />;
  if (conclusion === "cancelled") return <StatusBadge tone="cancelled" label="Cancelled" />;
  if (conclusion === "failure" || conclusion === "timed_out")
    return <StatusBadge tone="danger" label={conclusion === "failure" ? "Failed" : "Timed out"} />;
  return (
    <StatusBadge tone="idle" label={conclusion ? conclusion.replaceAll("_", " ") : "Completed"} />
  );
}
