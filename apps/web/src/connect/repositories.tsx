import { useState, type FormEvent, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api.js";
import { Button, Card, inputClass, Notice } from "./ui.js";

type Accounts = FunctionReturnType<typeof api.githubIdentity.list>["accounts"];

function Label({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[15px] font-medium">
      {label}
      {children}
    </label>
  );
}

export function RepositoryConnections({ accounts }: { accounts: Accounts }) {
  const machines = useQuery(api.machines.list, {});
  const bindings = useQuery(api.repositoryBindings.list, {});
  const enable = useAction(api.githubRepositories.enable);
  const disable = useMutation(api.repositoryBindings.disable);
  const [accountId, setAccountId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const selectedMachine = machines?.find((item) => item._id === machineId && !item.revoked);
  const environments = selectedMachine?.environments ?? [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    const account = accounts.find((item) => item.id === accountId);
    const machine = machines?.find((item) => item._id === machineId && !item.revoked);
    if (
      !account ||
      !machine ||
      !environments.some((item) => item.id === environmentId && item.state === "ready")
    )
      return;
    setWorking(true);
    setMessage("");
    try {
      await enable({
        accountId: account.id,
        machineId: machine._id,
        repositoryName,
        ...(repositoryOwner ? { repositoryOwner } : {}),
        environmentId,
      });
      setMessage("Repository connected. Runner readiness must still be verified on your Mac.");
    } catch {
      setMessage(
        "Connection failed. Check the repository owner and name, App installation, repository administrator access and local environment ID. Public repositories must require approval for all external contributors.",
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <Card label="Repository connections">
      <h2 className="text-xl font-medium">Repository connections</h2>
      <p className="text-muted">
        Choose which prepared environment can serve a personal or organization repository.
        Organization access requires a verified repository administrator. Public repositories must
        require GitHub approval for all external contributors.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={working} className="grid gap-4 sm:grid-cols-2">
          <Label label="GitHub account">
            <select
              className={inputClass}
              required
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Select an account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.login}
                </option>
              ))}
            </select>
          </Label>
          <Label label="Organization (optional)">
            <input
              className={inputClass}
              value={repositoryOwner}
              pattern="[A-Za-z0-9-]+"
              onChange={(event) => setRepositoryOwner(event.target.value)}
              placeholder="Selected GitHub account"
            />
          </Label>
          <Label label="Repository name">
            <input
              className={inputClass}
              required
              value={repositoryName}
              pattern="[A-Za-z0-9_.-]+"
              onChange={(event) => setRepositoryName(event.target.value)}
              placeholder="my-repository"
            />
          </Label>
          <Label label="Machine">
            <select
              className={inputClass}
              required
              value={machineId}
              onChange={(event) => {
                setMachineId(event.target.value);
                setEnvironmentId("");
              }}
            >
              <option value="">Select your Mac</option>
              {machines
                ?.filter((machine) => !machine.revoked)
                .map((machine) => (
                  <option key={machine._id} value={machine._id}>
                    {machine.name}
                  </option>
                ))}
            </select>
          </Label>
          <div className="sm:col-span-2">
            <Label label="Prepared environment">
              <select
                className={inputClass}
                required
                value={environmentId}
                onChange={(event) => setEnvironmentId(event.target.value)}
                aria-describedby="environment-help"
              >
                <option value="">Select an environment</option>
                {environments.map((environment) => (
                  <option
                    key={environment.id}
                    value={environment.id}
                    disabled={environment.state !== "ready"}
                  >
                    {environment.name} / {environment.os} / {environment.cpu} cores /{" "}
                    {environment.memoryMiB} MiB
                    {environment.state !== "ready" ? " / Setup required" : ""}
                  </option>
                ))}
              </select>
            </Label>
            <p id="environment-help" className="mt-2 text-[14px] text-muted">
              {environments.length
                ? "Last reported by your Mac. The service checks current readiness before running work."
                : "Connect your Mac and register a prepared image in its Environments view."}
            </p>
          </div>
          <div>
            <Button type="submit">Connect repository</Button>
          </div>
        </fieldset>
      </form>
      {message && <Notice>{message}</Notice>}
      {!!bindings?.length && (
        <ul className="flex flex-col divide-y divide-hairline">
          {bindings.map((binding) => (
            <li key={binding._id} className="flex items-center justify-between gap-4 py-3">
              <span>
                <span className="font-medium">
                  {binding.repositoryOwner ??
                    accounts.find((account) => account.id === binding.accountId)?.login ??
                    "Unknown account"}
                  /{binding.repositoryName}
                </span>
                <span className="block font-mono text-[13px] text-muted">
                  {binding.environmentId} / {binding.enabled ? "Connected" : "Disabled"}
                </span>
              </span>
              {binding.enabled && (
                <Button
                  variant="secondary"
                  disabled={working}
                  onClick={() => {
                    setWorking(true);
                    void disable({ id: binding._id })
                      .catch(() => setMessage("Could not disable this connection. Try again."))
                      .finally(() => setWorking(false));
                  }}
                >
                  Disable connection
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
