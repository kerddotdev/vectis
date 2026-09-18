import type { ButtonHTMLAttributes, ComponentProps, ReactElement, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { osIcons, osNames } from "@vectis/design/os-icons";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const buttonStyles = {
  primary: "bg-brand-fill text-on-brand hover:brightness-105",
  secondary: "bg-raised text-foreground ring-1 ring-hairline-strong hover:bg-hairline",
  quiet: "text-muted hover:bg-hairline hover:text-foreground",
  danger: "text-danger hover:bg-danger/10",
} as const;

export const buttonClass = (variant: keyof typeof buttonStyles = "primary", small = false) =>
  cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap no-underline transition outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    small ? "h-8 px-3.5 text-[14px]" : "h-10 px-5 text-[15px]",
    buttonStyles[variant],
  );

export function Button({
  variant = "primary",
  small = false,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
  small?: boolean;
}) {
  return <button type={type} className={cx(buttonClass(variant, small), className)} {...props} />;
}

export const inputClass =
  "h-10 w-full rounded-xl bg-raised px-3.5 text-[15px] text-foreground ring-1 ring-hairline-strong outline-none placeholder:text-faint focus:ring-2 focus:ring-brand disabled:opacity-60";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[14px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-muted">{hint}</span>}
    </label>
  );
}

export function Select({
  value,
  onChange,
  placeholder,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: ReadonlyArray<{ value: string; label: string; detail?: string; disabled?: boolean }>;
  label: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root
      value={value || null}
      onValueChange={(next: string | null) => onChange(next ?? "")}
      items={options.map(({ value, label }) => ({ value, label }))}
      disabled={disabled ?? false}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cx(
          inputClass,
          "flex items-center justify-between gap-2 text-left data-placeholder:text-faint",
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="truncate" />
        <SelectPrimitive.Icon>
          <ChevronDownIcon className="size-4 text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50">
          <SelectPrimitive.Popup className={cx(popupClass, "w-(--anchor-width)")}>
            <SelectPrimitive.List>
              {options.length === 0 && (
                <p className="px-3 py-2.5 text-[14px] text-muted">Nothing to choose yet</p>
              )}
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled ?? false}
                  className={itemClass}
                >
                  <span className="min-w-0 flex-1">
                    <SelectPrimitive.ItemText className="block truncate">
                      {option.label}
                    </SelectPrimitive.ItemText>
                    {option.detail && (
                      <span className="block truncate text-[13px] text-muted">{option.detail}</span>
                    )}
                  </span>
                  <SelectPrimitive.ItemIndicator>
                    <CheckIcon className="size-4 text-brand" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

const popupClass =
  "max-h-(--available-height) overflow-y-auto rounded-2xl bg-raised/90 p-1 text-foreground shadow-float ring-1 ring-hairline-strong outline-none backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,scale] duration-150 origin-(--transform-origin) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

const itemClass =
  "flex cursor-default items-center gap-3 rounded-xl px-3 py-2 text-[15px] outline-none select-none data-disabled:opacity-45 data-highlighted:bg-hairline";

export function ActionMenu({
  label,
  trigger,
  items,
}: {
  label: string;
  trigger: ReactNode;
  items: ReadonlyArray<{ label: string; onSelect: () => void; danger?: boolean }>;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className="grid size-9 place-items-center rounded-full text-muted transition outline-none hover:bg-hairline hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand data-popup-open:bg-hairline"
      >
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup className={cx(popupClass, "min-w-52")}>
            {items.map((item) => (
              <Menu.Item
                key={item.label}
                onClick={item.onSelect}
                className={cx(itemClass, item.danger && "text-danger")}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/10 backdrop-blur-md transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-y-auto rounded-3xl bg-raised p-6 text-foreground shadow-float ring-1 ring-hairline-strong outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <DialogPrimitive.Title className="text-xl font-medium">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="text-[15px] text-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mt-1 -mr-2 grid size-9 shrink-0 place-items-center rounded-full text-muted outline-none hover:bg-hairline hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Tip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup className="max-w-64 rounded-xl bg-foreground px-3 py-1.5 text-[13px] leading-snug text-background transition-[opacity,scale] duration-150 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TipProvider = (props: ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delay={300} {...props} />
);

const tones = {
  success: { icon: CircleCheckIcon, className: "bg-success/12 text-success" },
  attention: { icon: TriangleAlertIcon, className: "bg-attention/12 text-attention" },
  neutral: { icon: CircleIcon, className: "bg-neutral/12 text-neutral" },
  danger: { icon: TriangleAlertIcon, className: "bg-danger/12 text-danger" },
} as const;

export function Status({ tone, children }: { tone: keyof typeof tones; children: ReactNode }) {
  const { icon: Icon, className } = tones[tone];
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[13px] font-medium whitespace-nowrap",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
    </span>
  );
}

const noticeStyles = {
  info: { icon: InfoIcon, className: "bg-hairline", iconClassName: "text-muted" },
  attention: {
    icon: TriangleAlertIcon,
    className: "bg-attention/8 ring-1 ring-attention/25 ring-inset",
    iconClassName: "text-attention",
  },
  danger: {
    icon: TriangleAlertIcon,
    className: "bg-danger/8 ring-1 ring-danger/25 ring-inset",
    iconClassName: "text-danger",
  },
  success: {
    icon: CircleCheckIcon,
    className: "bg-success/8 ring-1 ring-success/25 ring-inset",
    iconClassName: "text-success",
  },
} as const;

export function Notice({
  tone = "info",
  role = "status",
  children,
}: {
  tone?: keyof typeof noticeStyles;
  role?: "status" | "alert";
  children: ReactNode;
}) {
  const { icon: Icon, className, iconClassName } = noticeStyles[tone];
  return (
    <div role={role} className={cx("flex gap-3 rounded-2xl px-4 py-3 text-[15px]", className)}>
      <Icon className={cx("mt-1 size-4 shrink-0", iconClassName)} aria-hidden />
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-3xl bg-surface ring-1 ring-hairline", className)}>
      {children}
    </section>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl px-6 py-14 text-center ring-1 ring-hairline ring-inset">
      <p className="text-[17px] font-medium">{title}</p>
      <div className="max-w-[46ch] text-[15px] text-muted">{children}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="py-10 text-center text-muted">
      {children}
    </p>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-hairline px-1.5 py-0.5 font-mono text-[0.88em]">{children}</code>
  );
}

export function VerificationCode({ value }: { value: string }) {
  return (
    <p className="rounded-2xl bg-hairline px-5 py-4 text-center font-mono text-2xl tracking-[0.3em]">
      {value}
    </p>
  );
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relative(value: number, now = Date.now()) {
  const minutes = Math.round((value - now) / 60000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return relativeFormat.format(Math.round(hours / 24), "day");
}

export function OsIcon({ os, className }: { os: keyof typeof osIcons; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("size-4 fill-current", className)} role="img">
      <title>{osNames[os]}</title>
      <path d={osIcons[os]} />
    </svg>
  );
}
