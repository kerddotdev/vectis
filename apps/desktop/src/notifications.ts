import type { Activity, Snapshot } from "../../../packages/protocol/src/index.js";
import type { VectisClient } from "../../../packages/client/src/index.js";

type NotificationStatus = "action_required" | "failed";
type KnownActivity = {
  status: Activity["status"];
  notified: ReadonlySet<NotificationStatus>;
};
export type KnownActivities = ReadonlyMap<string, KnownActivity>;

// Leaving a status does not reset its notification. Disappeared or evicted IDs are forgotten.
export function activityTransitions(
  previous: KnownActivities | undefined,
  activities: readonly Activity[],
  limit = 500,
) {
  const known = new Map<string, KnownActivity>();
  const notifications: Activity[] = [];
  const newest = activities
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
  for (const activity of newest) {
    const prior = previous?.get(activity.id);
    const notified = new Set(prior?.notified);
    if (activity.status === "action_required" || activity.status === "failed") {
      if (previous && prior?.status !== activity.status && !notified.has(activity.status))
        notifications.push(activity);
      notified.add(activity.status);
    }
    known.set(activity.id, { status: activity.status, notified });
  }
  return { known, notifications };
}

export class NotificationPoller {
  private known: KnownActivities | undefined;
  private revision: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: AbortController | undefined;
  private started = false;
  private stopped = false;
  private delay = 5000;

  constructor(
    private readonly options: {
      client: () => Promise<Pick<VectisClient, "status">>;
      enabled: () => boolean;
      focused: () => boolean;
      notify: (activity: Activity, snapshot: Snapshot) => void;
    },
  ) {}

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.reading?.abort();
    this.known = undefined;
  }

  private async poll() {
    const reading = new AbortController();
    this.reading = reading;
    try {
      const client = await this.options.client();
      if (this.stopped) return;
      const snapshot = await client.status(reading.signal);
      if (this.stopped) return;
      this.delay = 5000;
      if (snapshot.revision !== undefined && snapshot.revision === this.revision) return;
      this.revision = snapshot.revision;
      const transition = activityTransitions(this.known, snapshot.activities ?? []);
      this.known = transition.known;
      for (const activity of transition.notifications) {
        if (this.options.enabled() && !this.options.focused())
          this.options.notify(activity, snapshot);
      }
    } catch {
      this.delay = Math.min(this.delay * 2, 30000);
    } finally {
      this.reading = undefined;
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.delay);
    }
  }
}
