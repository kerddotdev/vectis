import type { Activity, Snapshot } from "../../../packages/protocol/src/index.js";
import { activityTitle, activitySummary } from "./activities.js";

type NativeNotification = {
  once(event: "click", listener: () => void): void;
  once(event: "close", listener: () => void): void;
  once(event: "failed", listener: () => void): void;
  removeAllListeners: () => void;
  show: () => void;
  close: () => void;
};

export class NativeNotifications {
  private readonly active = new Set<NativeNotification>();

  constructor(
    private readonly create: (content: { title: string; body: string }) => NativeNotification,
    private readonly openActivity: (id: string) => void,
  ) {}

  show(activity: Activity, snapshot: Snapshot) {
    if (this.active.size >= 50) {
      const oldest = this.active.values().next().value;
      if (oldest) this.dismiss(oldest);
    }
    const notification = this.create({
      title: activity.status === "action_required" ? "Vectis needs you" : "Vectis work failed",
      body: [activityTitle(activity, snapshot), activitySummary(activity, snapshot)]
        .filter(Boolean)
        .join("\n"),
    });
    this.active.add(notification);
    notification.once("click", () => {
      this.dismiss(notification);
      this.openActivity(activity.id);
    });
    notification.once("close", () => this.release(notification));
    notification.once("failed", () => this.release(notification));
    try {
      notification.show();
    } catch (error) {
      this.dismiss(notification);
      throw error;
    }
  }

  close() {
    for (const notification of this.active) this.dismiss(notification);
  }

  private release(notification: NativeNotification) {
    this.active.delete(notification);
    notification.removeAllListeners();
  }

  private dismiss(notification: NativeNotification) {
    this.release(notification);
    notification.close();
  }
}
