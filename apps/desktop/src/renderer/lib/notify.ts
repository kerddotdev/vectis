import { toastManager } from "@/components/ui/toast";

type Notification = {
  description?: string;
  action?: { label: string; onClick: () => void };
  id?: string;
};

// Anything that went wrong, and anything still waiting for a person, stays until it is dismissed.
// A confirmation of something that worked does not need the room.
function add(
  tone: "success" | "danger" | "attention" | "running",
  title: string,
  options?: Notification,
) {
  return toastManager.add({
    type: tone,
    title,
    priority: tone === "danger" ? "high" : "low",
    timeout: tone === "danger" || tone === "attention" ? 0 : undefined,
    ...(options?.id ? { id: options.id } : {}),
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.action
      ? { actionProps: { children: options.action.label, onClick: options.action.onClick } }
      : {}),
  });
}

export const notify = {
  success: (title: string, options?: Notification) => add("success", title, options),
  error: (title: string, options?: Notification) => add("danger", title, options),
  attention: (title: string, options?: Notification) => add("attention", title, options),
  started: (title: string, options?: Notification) => add("running", title, options),
};
