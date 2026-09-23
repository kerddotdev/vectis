import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import type { Activity } from "../../../../../packages/protocol/src/index.js";
import { ActivityRow } from "@/components/activity-row";
import { EmptyState, List, Page, Section, usePages } from "@/components/layout";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activityMatches } from "@/lib/activities";
import { useStateApi } from "@/state";

const statuses = {
  all: () => true,
  active: (activity: Activity) => ["accepted", "running"].includes(activity.status),
  attention: (activity: Activity) => activity.status === "action_required",
  failed: (activity: Activity) => ["failed", "cancelled"].includes(activity.status),
} as const;

const dayLabel = (value: string) => {
  const day = new Date(value);
  const today = new Date();
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((start(today).getTime() - start(day).getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

export function Activities() {
  const { snapshot } = useStateApi();
  const opened = useSearch({ from: "/activities" }).id;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<keyof typeof statuses>("all");
  const [kind, setKind] = useState("all");
  const [grouping, setGrouping] = useState("day");
  const activities = (snapshot?.activities ?? [])
    .filter((activity) => kind === "all" || activity.kind === kind)
    .filter(statuses[status])
    .filter((activity) => activityMatches(activity, snapshot, query));
  const groups = new Map<string, Activity[]>();
  for (const activity of activities) {
    const key =
      grouping === "day" ? dayLabel(activity.createdAt) : (activity.repository?.name ?? "This Mac");
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  }
  return (
    <Page
      title="Activity"
      description="What this Mac was asked to do, and what GitHub asked of it."
      actions={
        <Select
          value={grouping}
          onValueChange={(value: string | null) => value && setGrouping(value)}
          items={[
            { value: "day", label: "Group by day" },
            { value: "repository", label: "Group by repository" },
          ]}
        >
          <SelectTrigger size="sm" className="w-[9.5rem]" aria-label="Group activity by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Group by day</SelectItem>
            <SelectItem value="repository">Group by repository</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-8"
            type="search"
            placeholder="Search activity"
            aria-label="Search activity"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          value={kind}
          onValueChange={(value: string | null) => value && setKind(value)}
          items={[
            { value: "all", label: "All activity" },
            { value: "vectis", label: "Vectis" },
            { value: "github", label: "GitHub" },
          ]}
        >
          <SelectTrigger size="sm" className="w-[8.5rem]" aria-label="Filter by kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All activity</SelectItem>
            <SelectItem value="vectis">Vectis</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
          </SelectContent>
        </Select>
        <Tabs value={status} onValueChange={(value: keyof typeof statuses) => setStatus(value)}>
          <TabsList className="group-data-horizontal/tabs:h-7">
            <TabsTrigger value="all" className="px-2.5 text-xs">
              All
            </TabsTrigger>
            <TabsTrigger value="active" className="px-2.5 text-xs">
              Active
            </TabsTrigger>
            <TabsTrigger value="attention" className="px-2.5 text-xs">
              Needs you
            </TabsTrigger>
            <TabsTrigger value="failed" className="px-2.5 text-xs">
              Failed
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {groups.size === 0 ? (
        <EmptyState>
          {snapshot?.activities?.length
            ? "Nothing matches these filters."
            : "What you ask this Mac to do appears here."}
        </EmptyState>
      ) : (
        [...groups].map(([label, items]) => (
          <Group key={label} label={label} items={items} opened={opened} />
        ))
      )}
    </Page>
  );
}

function Group({ label, items, opened }: { label: string; items: Activity[]; opened?: string }) {
  const { items: page, pager } = usePages(items, 20);
  return (
    <Section title={label}>
      <List>
        {page.map((activity) => (
          <ActivityRow
            key={activity.id}
            activity={activity}
            defaultOpen={activity.id === opened || activity.status === "action_required"}
          />
        ))}
        {pager}
      </List>
    </Section>
  );
}
