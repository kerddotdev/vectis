import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api.js";

type Accounts = FunctionReturnType<typeof api.githubIdentity.list>["accounts"];
export function RepositoryConnections({ accounts }: { accounts: Accounts }) {
  const machines = useQuery(api.machines.list, {});
  const bindings = useQuery(api.repositoryBindings.list, {});
  const enable = useAction(api.githubRepositories.enable);
  const disable = useMutation(api.repositoryBindings.disable);
  const [accountId, setAccountId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
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
        environmentId,
      });
      setMessage("Repository connected. Runner readiness must still be verified on your Mac.");
    } catch {
      setMessage(
        "Connection failed. Check the private repository name, App installation, and local environment ID.",
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <section aria-labelledby="repositories-title">
      <h2 id="repositories-title">Repository connections</h2>
      <p>
        Choose which prepared environment can serve a private repository owned by your connected
        personal account.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={working}>
          <label>
            GitHub account
            <select
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
          </label>
          <label>
            Repository name
            <input
              required
              value={repositoryName}
              pattern="[A-Za-z0-9_.-]+"
              onChange={(event) => setRepositoryName(event.target.value)}
              placeholder="my-repository"
            />
          </label>
          <label>
            Machine
            <select
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
          </label>
          <label>
            Prepared environment
            <select
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
          </label>
          <p id="environment-help" className="muted">
            {environments.length
              ? "Last reported by your Mac. The service checks current readiness before running work."
              : "Connect your Mac and register a prepared image in its Environments view."}
          </p>
          <button type="submit">Connect repository</button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
      {bindings?.map((binding) => (
        <div key={binding._id} className="repository">
          <p>
            <strong>{binding.repositoryName}</strong> / {binding.environmentId} /{" "}
            {binding.enabled ? "Connected" : "Disabled"}
          </p>
          {binding.enabled && (
            <button
              className="secondary"
              disabled={working}
              onClick={() => {
                setWorking(true);
                void disable({ id: binding._id })
                  .catch(() => setMessage("Could not disable this connection. Try again."))
                  .finally(() => setWorking(false));
              }}
            >
              Disable connection
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
