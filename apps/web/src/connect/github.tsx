import { RepositoryConnections } from "./repositories.js";
import { useState } from "react";
import { SignIn, UserButton } from "@clerk/react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api.js";

export function GitHubConnections() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const data = useQuery(api.githubIdentity.list, isAuthenticated ? {} : "skip");
  const begin = useAction(api.githubOAuth.begin);
  const confirm = useMutation(api.githubIdentity.confirm);
  const discard = useMutation(api.githubIdentity.discard);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function perform(work: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await work();
    } catch (issue) {
      const code =
        issue instanceof ConvexError &&
        issue.data &&
        typeof issue.data === "object" &&
        "code" in issue.data
          ? String(issue.data.code)
          : "github_unavailable";
      setError(
        `The connection could not be updated (${code}). Try again or start a new GitHub request.`,
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <h1>Connect GitHub.</h1>
      <p>
        Link the accounts you use for your repositories. You can choose a different GitHub account
        each time.
      </p>
      {isLoading ? (
        <p role="status">Checking your account...</p>
      ) : !isAuthenticated ? (
        <SignIn
          routing="hash"
          fallbackRedirectUrl="/connect?github=1"
          signUpFallbackRedirectUrl="/connect?github=1"
        />
      ) : (
        <>
          <div className="account">
            <UserButton />
            <span>Your Vectis account owns these connections.</span>
          </div>
          {!data ? (
            <p role="status">Loading GitHub connections...</p>
          ) : (
            <>
              {data.accounts.map((account) => (
                <section
                  key={account.githubId}
                  aria-label={`Connected GitHub account ${account.login}`}
                >
                  <h2>{account.login}</h2>
                  <p className="status">Account linked</p>
                  <p>
                    {account.installations.length === 0
                      ? "No active App installation was found for this account."
                      : `Found ${account.installations.length} active App installation(s) during verification.`}
                  </p>
                  {account.installations.length > 0 && (
                    <ul>
                      {account.installations.map((installation) => (
                        <li key={installation.id}>
                          {installation.login} (installation {installation.id})
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="muted">
                    Repository permissions and runner readiness must still be checked before
                    enabling jobs.
                  </p>
                </section>
              ))}
              <RepositoryConnections accounts={data.accounts} />
              {data.pending.map((link) => (
                <section key={link.id} aria-label="Pending GitHub connection">
                  {link.phase === "review" && link.user ? (
                    <>
                      <h2>Link {link.user.login}?</h2>
                      <p>
                        GitHub verified this account. Confirm only if this is the account you
                        intended to connect.
                      </p>
                      <button
                        disabled={working}
                        onClick={() => void perform(() => confirm({ id: link.id }))}
                      >
                        Link {link.user.login}
                      </button>
                    </>
                  ) : (
                    <p role="status">
                      {link.phase === "failed"
                        ? "GitHub verification failed. Dismiss this request and start again."
                        : "GitHub verification is pending. Complete authorization in GitHub, or dismiss this request to start again."}
                    </p>
                  )}
                  <button
                    className="secondary"
                    disabled={working}
                    onClick={() => void perform(() => discard({ id: link.id }))}
                  >
                    Dismiss request
                  </button>
                </section>
              ))}
              <button
                disabled={working}
                onClick={() =>
                  void perform(async () => {
                    const result = await begin({});
                    location.assign(result.url);
                  })
                }
              >
                Connect a GitHub account
              </button>
              <p className="notice">
                Only start authorization from Vectis. Linking an account does not start jobs or
                modify workflows.
              </p>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        <a href="/connect">Connect a machine</a>
      </p>
    </>
  );
}
