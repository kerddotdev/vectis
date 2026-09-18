import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CircleCheckIcon,
  FolderGit2Icon,
  KeyRoundIcon,
  LaptopIcon,
  LayoutGridIcon,
  type LucideIcon,
} from "lucide-react";
import { site } from "@vectis/design/site";
import { api } from "../../../../convex/_generated/api.js";
import { AccessTab } from "./access.js";
import { GitHubMark, GitHubTab, useLinkGitHub } from "./github.js";
import { RepositoriesTab } from "./repositories.js";
import {
  Button,
  buttonClass,
  Code,
  cx,
  Empty,
  Notice,
  OsIcon,
  Panel,
  Pending,
  relative,
  Status,
} from "./ui.js";

export type Machines = FunctionReturnType<typeof api.machines.list>;
export type Identity = FunctionReturnType<typeof api.githubIdentity.list>;
export type Bindings = FunctionReturnType<typeof api.repositoryBindings.list>;

const tabs = [
  { id: "overview", label: "Overview", icon: LayoutGridIcon },
  { id: "machines", label: "Macs", icon: LaptopIcon },
  { id: "github", label: "GitHub", icon: null },
  { id: "repositories", label: "Repositories", icon: FolderGit2Icon },
  { id: "access", label: "Remote access", icon: KeyRoundIcon },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: LucideIcon | null }>;
export type Tab = (typeof tabs)[number]["id"];

function initialTab(): Tab {
  const query = new URLSearchParams(location.search);
  if (query.get("github") === "1") return "github";
  if (query.get("controller") === "1") return "access";
  const requested = query.get("tab");
  return tabs.find((tab) => tab.id === requested)?.id ?? "overview";
}

export const online = (machine: Machines[number]) =>
  !machine.revoked && machine.lastSeenAt !== undefined && Date.now() - machine.lastSeenAt < 90000;

export function Header({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="flex max-w-[60ch] flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-medium tracking-[-0.02em]">{title}</h1>
        <p className="text-[15px] text-muted">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Dashboard() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const identity = useQuery(api.githubIdentity.list, {});
  const machines = useQuery(api.machines.list, {});
  const bindings = useQuery(api.repositoryBindings.list, {});
  const controllers = useQuery(api.controllers.list, {});
  useEffect(() => {
    history.replaceState(null, "", tab === "overview" ? "/connect" : `/connect?tab=${tab}`);
  }, [tab]);
  const activeMachines = machines?.filter((machine) => !machine.revoked);
  const counts: Partial<Record<Tab, number | undefined>> = {
    machines: activeMachines?.length,
    github: identity?.accounts.length,
    repositories: bindings?.filter((binding) => binding.enabled).length,
    access: controllers?.length,
  };
  return (
    <div className="mx-auto grid max-w-[1180px] gap-8 px-5 py-8 md:py-12 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
      <nav
        aria-label="Account sections"
        className="-mx-5 flex gap-1 overflow-x-auto px-5 lg:sticky lg:top-24 lg:mx-0 lg:flex-col lg:self-start lg:overflow-visible lg:px-0"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
            className="flex h-9 shrink-0 items-center gap-2.5 rounded-full px-3.5 text-[15px] whitespace-nowrap text-muted transition outline-none hover:bg-hairline hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand aria-[current=page]:bg-hairline aria-[current=page]:text-foreground lg:rounded-xl"
          >
            {Icon ? <Icon className="size-4" aria-hidden /> : <GitHubMark className="size-4" />}
            {label}
            {counts[id] !== undefined && counts[id] > 0 && (
              <span className="ml-auto pl-2 text-[13px] text-faint tabular-nums">{counts[id]}</span>
            )}
          </button>
        ))}
      </nav>
      <div key={tab} className="enter flex min-w-0 flex-col gap-8">
        {tab === "overview" && (
          <Overview
            machines={activeMachines}
            identity={identity}
            bindings={bindings}
            onOpen={setTab}
          />
        )}
        {tab === "machines" && <MachinesTab machines={activeMachines} />}
        {tab === "github" && <GitHubTab identity={identity} />}
        {tab === "repositories" && (
          <RepositoriesTab bindings={bindings} identity={identity} machines={activeMachines} />
        )}
        {tab === "access" && <AccessTab controllers={controllers} />}
      </div>
    </div>
  );
}

function Step({
  done,
  index,
  title,
  children,
  action,
}: {
  done: boolean;
  index: number;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
      <span
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-full text-[14px] font-medium tabular-nums",
          done ? "bg-success/12 text-success" : "bg-hairline text-muted",
        )}
      >
        {done ? <CircleCheckIcon className="size-4" aria-label="Done" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("font-medium", done && "text-muted")}>{title}</p>
        <div className="mt-1 text-[15px] text-muted">{children}</div>
      </div>
      {!done && action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function Overview({
  machines,
  identity,
  bindings,
  onOpen,
}: {
  machines: Machines | undefined;
  identity: Identity | undefined;
  bindings: Bindings | undefined;
  onOpen: (tab: Tab) => void;
}) {
  const link = useLinkGitHub();
  if (!machines || !identity || !bindings) return <Pending>Loading your account</Pending>;
  const steps = {
    mac: machines.length > 0,
    github: identity.accounts.length > 0,
    app: identity.accounts.some((account) => account.installations.length > 0),
    repository: bindings.some((binding) => binding.enabled),
  };
  const remaining = Object.values(steps).filter((done) => !done).length;
  return (
    <>
      <Header
        title={remaining ? "Get set up" : "You are all set"}
        description={
          remaining
            ? "Four steps take a repository from GitHub to a clean VM on your Mac. Each one stays in your control."
            : "GitHub can start jobs on your Macs. Add more repositories or Macs at any time."
        }
      />
      <Panel>
        <ol className="flex flex-col divide-y divide-hairline">
          <Step
            done={steps.mac}
            index={1}
            title="Connect a Mac"
            action={
              <a className={buttonClass("secondary", true)} href={site.download}>
                Download Vectis
              </a>
            }
          >
            In the Vectis app, open Connections and choose Connect in browser. From a terminal, run{" "}
            <Code>vectis cloud pair</Code>.
          </Step>
          <Step
            done={steps.github}
            index={2}
            title="Link a GitHub account"
            action={
              <Button small disabled={link.working} onClick={link.start}>
                Link GitHub
              </Button>
            }
          >
            Proves which GitHub accounts are yours. It does not start jobs or change workflows.
          </Step>
          <Step
            done={steps.app}
            index={3}
            title="Install the Vectis GitHub App"
            action={
              steps.github && (
                <Button small variant="secondary" disabled={link.working} onClick={link.start}>
                  Link again to refresh
                </Button>
              )
            }
          >
            Install it on the account or organization that owns your repositories, then link the
            account again so Vectis sees the installation.
          </Step>
          <Step
            done={steps.repository}
            index={4}
            title="Connect a repository"
            action={
              <Button
                small
                variant={steps.mac && steps.app ? "primary" : "secondary"}
                onClick={() => onOpen("repositories")}
              >
                Choose repository
              </Button>
            }
          >
            Pick the repository, the Mac and the prepared environment its jobs run in.
          </Step>
        </ol>
      </Panel>
      {link.error && (
        <Notice tone="danger" role="alert">
          {link.error}
        </Notice>
      )}
      {remaining < 4 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [
                "machines",
                "Macs",
                `${machines.filter(online).length} online of ${machines.length}`,
              ],
              ["github", "GitHub accounts", `${identity.accounts.length} linked`],
              [
                "repositories",
                "Repositories",
                `${bindings.filter((binding) => binding.enabled).length} connected`,
              ],
            ] as const
          ).map(([id, label, detail]) => (
            <button
              key={id}
              type="button"
              onClick={() => onOpen(id)}
              className="flex flex-col gap-1 rounded-2xl bg-surface px-5 py-4 text-left ring-1 ring-hairline transition outline-none hover:ring-hairline-strong focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="text-[14px] text-muted">{label}</span>
              <span className="font-medium">{detail}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function MachinesTab({ machines }: { machines: Machines | undefined }) {
  return (
    <>
      <Header
        title="Macs"
        description="Macs connected to your account. Each one runs jobs in its own VMs and reports its prepared environments here."
      />
      {!machines ? (
        <Pending>Loading your Macs</Pending>
      ) : machines.length === 0 ? (
        <Empty
          title="No Macs yet"
          action={
            <a className={buttonClass("secondary", true)} href="/docs/guides/local-setup">
              Read the setup guide
            </a>
          }
        >
          In the Vectis app, open Connections and choose Connect in browser, or run{" "}
          <Code>vectis cloud pair</Code>. You approve the request on this page.
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {machines.map((machine) => (
            <Panel key={machine._id} className="flex flex-col gap-5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-[17px] font-medium">{machine.name}</p>
                  <p className="text-[14px] text-muted">
                    {machine.lastSeenAt
                      ? `Last seen ${relative(machine.lastSeenAt)}`
                      : "Not seen yet"}
                  </p>
                </div>
                {machine.paused ? (
                  <Status tone="attention">New VMs paused</Status>
                ) : online(machine) ? (
                  <Status tone="success">Online</Status>
                ) : (
                  <Status tone="neutral">Offline</Status>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-[14px] text-muted">Prepared environments</p>
                {machine.environments?.length ? (
                  <ul className="flex flex-col divide-y divide-hairline rounded-2xl ring-1 ring-hairline">
                    {machine.environments.map((environment) => (
                      <li key={environment.id} className="flex items-center gap-3 px-4 py-2.5">
                        <OsIcon os={environment.os} className="size-4 text-muted" />
                        <span className="min-w-0 flex-1 truncate text-[15px]">
                          {environment.name}
                        </span>
                        {environment.state === "ready" ? (
                          <Status tone="success">Ready</Status>
                        ) : (
                          <Status tone="attention">Setup required</Status>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[15px] text-muted">
                    None reported yet. Prepare one in the app's Environments view.
                  </p>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
