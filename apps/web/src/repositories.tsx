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
  async function submit(event: FormEvent) {
    event.preventDefault();
    const account = accounts.find((item) => item.id === accountId);
    const machine = machines?.find((item) => item._id === machineId && !item.revoked);
    if (!account || !machine) return;
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
              onChange={(event) => setMachineId(event.target.value)}
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
            Environment ID
            <input
              required
              value={environmentId}
              pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,79}"
              onChange={(event) => setEnvironmentId(event.target.value)}
              aria-describedby="environment-help"
            />
          </label>
          <p id="environment-help" className="muted">
            Use the ID shown in your local Environments view.
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
