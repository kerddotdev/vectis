import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import { tones, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";

export const toastManager = ToastPrimitive.createToastManager();

export function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={toastManager} timeout={4500} limit={4}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-50 flex w-[21rem] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2 outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => {
    const tone = (toast.type && toast.type in tones ? toast.type : "queued") as Tone;
    const { icon: Icon, className } = tones[tone];
    return (
      <ToastPrimitive.Root
        key={toast.id}
        toast={toast}
        className="flex gap-3 rounded-2xl bg-popover px-4 py-3 shadow-lg ring-1 ring-border transition-[transform,opacity] duration-200 ease-out data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
      >
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            className.split(" ").filter((name) => name.startsWith("text-")),
          )}
          aria-hidden
        />
        <ToastPrimitive.Content className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastPrimitive.Title className="font-medium" />
          <ToastPrimitive.Description
            className="text-muted-foreground empty:hidden"
            data-selectable
          />
          {toast.actionProps && (
            <ToastPrimitive.Action
              className="mt-1 self-start"
              render={<Button variant="secondary" size="xs" />}
            />
          )}
        </ToastPrimitive.Content>
        <ToastPrimitive.Close
          className="-mt-0.5 -mr-1.5 shrink-0"
          aria-label="Dismiss"
          render={<Button variant="ghost" size="icon-xs" />}
        >
          <XIcon />
        </ToastPrimitive.Close>
      </ToastPrimitive.Root>
    );
  });
}
