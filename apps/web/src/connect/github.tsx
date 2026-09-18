import { useState } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../../convex/_generated/api.js";
import { Account, SignInPanel } from "./Connect.js";
import { RepositoryConnections } from "./repositories.js";
import { Button, Card, Heading, Notice, Pending } from "./ui.js";

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
      <Heading eyebrow="GitHub" title="Connect GitHub.">
        <p>
          Link the accounts you use for your repositories. You can choose a different GitHub account
          each time.
        </p>
      </Heading>
      {isLoading ? (
        <Pending>Checking your account</Pending>
      ) : !isAuthenticated ? (
        <SignInPanel redirect="/connect?github=1" />
      ) : (
        <>
          <Account>Your Vectis account owns these connections.</Account>
          {!data ? (
            <Pending>Loading GitHub connections</Pending>
          ) : (
            <>
              {data.accounts.map((account) => (
                <Card key={account.githubId} label={`Connected GitHub account ${account.login}`}>
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="text-xl font-medium">{account.login}</h2>
                    <span className="rounded-full bg-success/12 px-2.5 py-1 text-[13px] font-medium text-success">
                      Account linked
                    </span>
                  </div>
                  <p className="text-muted">
                    {account.installations.length === 0
                      ? "No active App installation was found for this account."
                      : `Found ${account.installations.length} active App installation(s) during verification.`}
                  </p>
                  {account.installations.length > 0 && (
                    <ul className="flex flex-col gap-1 font-mono text-[13px]">
                      {account.installations.map((installation) => (
                        <li key={installation.id}>
                          {installation.login} (installation {installation.id})
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[15px] text-muted">
                    Repository permissions and runner readiness must still be checked before
                    enabling jobs.
                  </p>
                </Card>
              ))}
              <RepositoryConnections accounts={data.accounts} />
              {data.pending.map((link) => (
                <Card key={link.id} label="Pending GitHub connection">
                  {link.phase === "review" && link.user ? (
                    <>
                      <h2 className="text-xl font-medium">Link {link.user.login}?</h2>
                      <p className="text-muted">
                        GitHub verified this account. Confirm only if this is the account you
                        intended to connect.
                      </p>
                    </>
                  ) : (
                    <Pending>
                      {link.phase === "failed"
                        ? "GitHub verification failed. Dismiss this request and start again."
                        : "GitHub verification is pending. Complete authorization in GitHub, or dismiss this request to start again."}
                    </Pending>
                  )}
                  <div className="flex flex-wrap gap-3">
                    {link.phase === "review" && link.user && (
                      <Button
                        disabled={working}
                        onClick={() => void perform(() => confirm({ id: link.id }))}
                      >
                        Link {link.user.login}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() => void perform(() => discard({ id: link.id }))}
                    >
                      Dismiss request
                    </Button>
                  </div>
                </Card>
              ))}
              <div className="flex flex-col items-start gap-4">
                <Button
                  disabled={working}
                  onClick={() =>
                    void perform(async () => {
                      const result = await begin({});
                      location.assign(result.url);
                    })
                  }
                >
                  Connect a GitHub account
                </Button>
                <Notice>
                  Only start authorization from Vectis. Linking an account does not start jobs or
                  modify workflows.
                </Notice>
              </div>
            </>
          )}
        </>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <a className="text-[15px] text-brand underline-offset-4 hover:underline" href="/connect">
        Connect a machine
      </a>
    </>
  );
}
