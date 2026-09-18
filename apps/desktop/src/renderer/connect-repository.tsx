import { useState } from "react";
import { Schema } from "effect";
import { GitHubAccounts } from "../../../../packages/protocol/src/repositories.js";
import { useStateApi } from "./state.js";

export function ConnectRepository() {
  const { snapshot, perform, submit } = useStateApi();
  const [accounts, setAccounts] = useState<GitHubAccounts>([]);
  const [accountId, setAccountId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    setPending(true);
    try {
      const result = await perform("github.accounts");
      if (result !== undefined) {
        const available = Schema.decodeUnknownSync(GitHubAccounts)(result);
        setAccounts(available);
        setMessage(available.length ? "" : "Connect a GitHub account in the browser first.");
      }
    } catch {
      setMessage("GitHub accounts could not be read.");
    } finally {
      setPending(false);
    }
  }
  async function connect() {
    setPending(true);
    try {
      const result = await submit({
        type: "repository.connect",
        accountId,
        repositoryName,
        ...(repositoryOwner ? { repositoryOwner } : {}),
        environmentId,
      });
      if (result !== undefined)
        setMessage(
          "Connection requested. Follow its operation in Overview, then refresh repositories.",
        );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="section">
      <h2>Connect a repository</h2>
      <button disabled={pending} onClick={() => void load()}>
        Load verified GitHub accounts
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <fieldset disabled={pending}>
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
            Repository owner (optional organization)
            <input
              value={repositoryOwner}
              pattern="[A-Za-z0-9-]+"
              onChange={(event) => setRepositoryOwner(event.target.value)}
              placeholder="Selected GitHub account"
            />
          </label>
          <label>
            Repository name
            <input
              required
              pattern="[A-Za-z0-9_.-]+"
              value={repositoryName}
              onChange={(event) => setRepositoryName(event.target.value)}
            />
          </label>
          <label>
            Prepared environment
            <select
              required
              value={environmentId}
              onChange={(event) => setEnvironmentId(event.target.value)}
            >
              <option value="">Select an environment</option>
              {snapshot?.environments
                .filter((environment) => environment.state === "ready")
                .map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit">Connect repository</button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
