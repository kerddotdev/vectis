import type { ButtonHTMLAttributes, ReactNode } from "react";

const buttonStyles = {
  primary: "bg-brand-fill text-on-brand hover:brightness-105",
  secondary: "bg-raised text-foreground ring-1 ring-hairline-strong hover:bg-hairline",
  quiet: "text-muted hover:bg-hairline hover:text-foreground",
} as const;

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles }) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${buttonStyles[variant]} ${className}`}
      {...props}
    />
  );
}

export const linkButton =
  "inline-flex h-10 items-center justify-center rounded-full bg-brand-fill px-5 text-[15px] font-medium text-on-brand no-underline transition hover:brightness-105";

export const inputClass =
  "h-10 w-full rounded-xl bg-raised px-3.5 text-[15px] text-foreground ring-1 ring-hairline-strong outline-none placeholder:text-faint focus:ring-2 focus:ring-brand";

export function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 className="text-title font-medium">{title}</h1>
      {children && <div className="max-w-[56ch] text-lede text-muted">{children}</div>}
    </header>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-4 rounded-3xl bg-surface p-6 ring-1 ring-hairline"
    >
      {children}
    </section>
  );
}

const noticeStyles = {
  info: "bg-hairline text-muted",
  attention: "bg-attention/10 text-foreground ring-1 ring-attention/25",
  danger: "bg-danger/10 text-foreground ring-1 ring-danger/25",
  success: "bg-success/10 text-foreground ring-1 ring-success/25",
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
  return (
    <p
      role={role}
      className={`rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${noticeStyles[tone]}`}
    >
      {children}
    </p>
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-muted">
      {children}
    </p>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-hairline px-1.5 py-0.5 text-[0.9em]">{children}</code>;
}
