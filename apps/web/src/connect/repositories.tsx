import { useState, type FormEvent } from "react";
import { useAction, useMutation } from "convex/react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, EllipsisIcon, PlusIcon, SearchIcon } from "lucide-react";
import { api } from "../../../../convex/_generated/api.js";
import { errorCode } from "./Connect.js";
import { Header, online, type Bindings, type Identity, type Machines } from "./dashboard.js";
import {
  ActionMenu,
  Button,
  cx,
  Dialog,
  Empty,
  Field,
  inputClass,
  Notice,
  OsIcon,
  Panel,
  Pending,
  Select,
  Status,
} from "./ui.js";

const filters = [
  { value: "all", label: "All repositories" },
  { value: "enabled", label: "Connected" },
  { value: "disabled", label: "Disabled" },
];

export function RepositoriesTab({
  bindings,
  identity,
  machines,
}: {
  bindings: Bindings | undefined;
  identity: Identity | undefined;
  machines: Machines | undefined;
}) {
  const disable = useMutation(api.repositoryBindings.disable);
  const [connecting, setConnecting] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>();
  const accounts = identity?.accounts ?? [];
  const name = (binding: Bindings[number]) =>
    `${binding.repositoryOwner ?? accounts.find((account) => account.id === binding.accountId)?.login ?? "unknown"}/${binding.repositoryName}`;
  const visible = (bindings ?? [])
    .filter((binding) =>
      filter === "all" ? true : filter === "enabled" ? binding.enabled : !binding.enabled,
    )
    .filter((binding) => name(binding).toLowerCase().includes(search.trim().toLowerCase()));
  const grouped = new Map<string, Bindings>();
  for (const binding of visible)
    grouped.set(name(binding), [...(grouped.get(name(binding)) ?? []), binding]);
  const groups = [...grouped].sort(([left], [right]) => left.localeCompare(right));
  const canConnect = accounts.length > 0 && (machines?.length ?? 0) > 0;
  return (
    <>
      <Header
        title="Repositories"
        description="Which repositories may run jobs on your Macs, and in which prepared environment. Nothing runs until GitHub queues a job that asks for it."
        actions={
          <Button disabled={!canConnect} onClick={() => setConnecting(true)}>
            <PlusIcon />
            Connect repository
          </Button>
        }
      />
      {!canConnect && identity && machines && (
        <Notice>
          {machines.length === 0
            ? "Connect a Mac first. Its prepared environments are where the jobs run."
            : "Link a GitHub account first, so Vectis can verify you administer the repository."}
        </Notice>
      )}
      {message && (
        <Notice tone={message.tone} role={message.tone === "danger" ? "alert" : "status"}>
          {message.text}
        </Notice>
      )}
      {!bindings || !identity ? (
        <Pending>Loading repositories</Pending>
      ) : bindings.length === 0 ? (
        <Empty title="No repositories connected">
          Connect a repository to let its GitHub Actions jobs run in a clean VM on one of your Macs.
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Search repositories</span>
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" />
              <input
                className={cx(inputClass, "pl-10")}
                type="search"
                placeholder="Search repositories"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="sm:w-52">
              <Select
                label="Filter repositories"
                value={filter}
                onChange={(value) => setFilter(value || "all")}
                placeholder="All repositories"
                options={filters}
              />
            </div>
          </div>
          <Panel>
            {visible.length === 0 ? (
              <p className="px-5 py-10 text-center text-[15px] text-muted">
                No repositories match.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline">
                {groups.map(([repository, items]) => {
                  const connected = items.filter((binding) => binding.enabled).length;
                  const hosts = new Set(items.map((binding) => binding.machineId)).size;
                  const status = connected ? (
                    <Status tone="success">{connected} connected</Status>
                  ) : (
                    <Status tone="neutral">Disabled</Status>
                  );
                  return (
                    <li key={repository}>
                      <Collapsible.Root>
                        <Collapsible.Trigger className="group flex w-full items-center gap-4 py-4 pr-5 pl-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset">
                          <ChevronRightIcon
                            className="size-4 shrink-0 text-muted transition-transform duration-200 group-data-panel-open:rotate-90"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium break-words sm:truncate">
                              {repository}
                            </span>
                            <span className="block text-[14px] text-muted">
                              {items.length} {items.length === 1 ? "environment" : "environments"}{" "}
                              on {hosts} {hosts === 1 ? "Mac" : "Macs"}
                            </span>
                            <span className="mt-2 block sm:hidden">{status}</span>
                          </span>
                          <span className="hidden sm:block">{status}</span>
                        </Collapsible.Trigger>
                        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 mt-2">
                          <ul className="mx-5 mb-4 flex flex-col divide-y divide-hairline rounded-2xl ring-1 ring-hairline ring-inset sm:ml-13">
                            {items.map((binding) => {
                              const machine = machines?.find(
                                (item) => item._id === binding.machineId,
                              );
                              const environment = machine?.environments?.find(
                                (item) => item.id === binding.environmentId,
                              );
                              return (
                                <li
                                  key={binding._id}
                                  className="flex items-center gap-3 py-2 pr-2 pl-4"
                                >
                                  {environment ? (
                                    <OsIcon os={environment.os} className="size-4 text-muted" />
                                  ) : (
                                    <span className="size-4" aria-hidden />
                                  )}
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[15px]">
                                      {environment?.name ?? binding.environmentId}
                                    </span>
                                    <span className="block truncate text-[13px] text-muted">
                                      {machine?.name ?? "A removed Mac"}
                                      {machine && !online(machine) && ", offline"}
                                    </span>
                                  </span>
                                  {binding.enabled ? (
                                    <Status tone="success">Connected</Status>
                                  ) : (
                                    <Status tone="neutral">Disabled</Status>
                                  )}
                                  {binding.enabled ? (
                                    <ActionMenu
                                      label={`Actions for ${repository} in ${environment?.name ?? binding.environmentId}`}
                                      trigger={<EllipsisIcon className="size-4" />}
                                      items={[
                                        {
                                          label: "Disable connection",
                                          danger: true,
                                          onSelect: () =>
                                            void disable({ id: binding._id })
                                              .then(() =>
                                                setMessage({
                                                  tone: "success",
                                                  text: `${repository} no longer starts jobs in ${environment?.name ?? binding.environmentId}.`,
                                                }),
                                              )
                                              .catch(() =>
                                                setMessage({
                                                  tone: "danger",
                                                  text: "The connection could not be disabled. Try again.",
                                                }),
                                              ),
                                        },
                                      ]}
                                    />
                                  ) : (
                                    <span className="size-9 shrink-0" aria-hidden />
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </Collapsible.Panel>
                      </Collapsible.Root>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      )}
      <Dialog
        open={connecting}
        onOpenChange={setConnecting}
        title="Connect a repository"
        description="Jobs from this repository will run in the environment you choose. Vectis checks that you administer the repository."
      >
        <ConnectForm
          identity={identity}
          machines={machines}
          onDone={(repository) => {
            setConnecting(false);
            setMessage({
              tone: "success",
              text: `${repository} is connected. Check runner readiness in the Vectis app on that Mac.`,
            });
          }}
        />
      </Dialog>
    </>
  );
}

function ConnectForm({
  identity,
  machines,
  onDone,
}: {
  identity: Identity | undefined;
  machines: Machines | undefined;
  onDone: (repository: string) => void;
}) {
  const enable = useAction(api.githubRepositories.enable);
  const [accountId, setAccountId] = useState("");
  const [owner, setOwner] = useState("");
  const [repository, setRepository] = useState("");
  const [machineId, setMachineId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const accounts = identity?.accounts ?? [];
  const account = accounts.find((item) => item.id === accountId);
  const machine = machines?.find((item) => item._id === machineId);
  const environments = machine?.environments ?? [];
  const ready = environments.some((item) => item.id === environmentId && item.state === "ready");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account || !machine || !ready) return;
    setWorking(true);
    setError("");
    try {
      await enable({
        accountId: account.id,
        machineId: machine._id,
        repositoryName: repository,
        ...(owner ? { repositoryOwner: owner } : {}),
        environmentId,
      });
      onDone(`${owner || account.login}/${repository}`);
    } catch (issue) {
      const code = errorCode(issue);
      setError(
        `The repository could not be connected${code ? ` (${code})` : ""}. Check the owner and name, that the GitHub App is installed there, and that you administer it. Public repositories must require approval for all outside contributors.`,
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={working} className="flex flex-col gap-4">
        <Field label="GitHub account">
          <Select
            label="GitHub account"
            value={accountId}
            onChange={setAccountId}
            placeholder="Choose an account"
            options={accounts.map((item) => ({
              value: item.id,
              label: item.login,
              detail: item.installations.length ? "App installed" : "App not installed",
            }))}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Owner" hint="Only for an organization repository.">
            <input
              className={inputClass}
              value={owner}
              pattern="[A-Za-z0-9-]+"
              placeholder={account?.login ?? "Account"}
              onChange={(event) => setOwner(event.target.value)}
            />
          </Field>
          <Field label="Repository">
            <input
              className={inputClass}
              required
              value={repository}
              pattern="[A-Za-z0-9_.-]+"
              placeholder="my-repository"
              onChange={(event) => setRepository(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Mac">
          <Select
            label="Mac"
            value={machineId}
            onChange={(value) => {
              setMachineId(value);
              setEnvironmentId("");
            }}
            placeholder="Choose a Mac"
            options={(machines ?? []).map((item) => ({
              value: item._id,
              label: item.name,
              detail: online(item) ? "Online" : "Offline",
            }))}
          />
        </Field>
        <Field
          label="Environment"
          hint={
            machine
              ? environments.length
                ? "As last reported by the Mac. It checks readiness again before each job."
                : "This Mac has not reported a prepared environment yet."
              : undefined
          }
        >
          <Select
            label="Environment"
            value={environmentId}
            onChange={setEnvironmentId}
            disabled={!machine}
            placeholder={machine ? "Choose an environment" : "Choose a Mac first"}
            options={environments.map((item) => ({
              value: item.id,
              label: item.name,
              detail: `${item.cpu} cores, ${Math.round(item.memoryMiB / 1024)} GB${item.state === "ready" ? "" : ", setup required"}`,
              disabled: item.state !== "ready",
            }))}
          />
        </Field>
      </fieldset>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={working || !account || !ready || !repository}>
          {working ? "Connecting" : "Connect repository"}
        </Button>
      </div>
    </form>
  );
}
