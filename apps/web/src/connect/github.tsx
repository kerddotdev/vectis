import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { EllipsisIcon } from "lucide-react";
import { api } from "../../../../convex/_generated/api.js";
import { errorCode } from "./Connect.js";
import { Header, type Bindings, type Identity } from "./dashboard.js";
import {
  ActionMenu,
  Button,
  Confirm,
  cx,
  Empty,
  Notice,
  Panel,
  Pending,
  relative,
  Status,
} from "./ui.js";

export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("fill-current", className)} aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function useLinkGitHub() {
  const begin = useAction(api.githubOAuth.begin);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  return {
    working,
    error,
    start() {
      setWorking(true);
      setError("");
      begin({})
        .then((result) => location.assign(result.url))
        .catch((issue: unknown) => {
          setError(
            `GitHub could not be reached (${errorCode(issue) || "github_unavailable"}). Try again.`,
          );
          setWorking(false);
        });
    },
  };
}

export function GitHubTab({
  identity,
  bindings,
}: {
  identity: Identity | undefined;
  bindings: Bindings | undefined;
}) {
  const link = useLinkGitHub();
  const confirm = useMutation(api.githubIdentity.confirm);
  const discard = useMutation(api.githubIdentity.discard);
  const unlink = useMutation(api.githubIdentity.unlink);
  const [unlinking, setUnlinking] = useState<Identity["accounts"][number] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function perform(work: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await work();
    } catch (issue) {
      setError(
        `The request could not be updated (${errorCode(issue) || "github_unavailable"}). Dismiss it and link the account again.`,
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <Header
        title="GitHub"
        description="Accounts you have proven are yours. Linking does not start jobs or change workflows; connecting a repository does."
        actions={
          <Button disabled={link.working} onClick={link.start}>
            <GitHubMark />
            Link GitHub account
          </Button>
        }
      />
      {(link.error || error) && (
        <Notice tone="danger" role="alert">
          {link.error || error}
        </Notice>
      )}
      {!identity ? (
        <Pending>Loading GitHub accounts</Pending>
      ) : (
        <>
          {identity.pending.map((request) => (
            <Panel key={request.id} className="flex flex-col gap-4 p-5 ring-attention/30">
              {request.phase === "review" && request.user ? (
                <div>
                  <p className="font-medium">Link {request.user.login}?</p>
                  <p className="mt-1 text-[15px] text-muted">
                    GitHub verified this account. Link it only if it is the account you meant to
                    connect.
                  </p>
                </div>
              ) : (
                <p className="text-[15px] text-muted">
                  {request.phase === "failed"
                    ? "GitHub verification failed. Dismiss this request and link the account again."
                    : "Waiting for GitHub. Finish authorizing there, or dismiss this request to start again."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {request.phase === "review" && request.user && (
                  <Button
                    small
                    disabled={working}
                    onClick={() => void perform(() => confirm({ id: request.id }))}
                  >
                    Link {request.user.login}
                  </Button>
                )}
                <Button
                  small
                  variant="quiet"
                  disabled={working}
                  onClick={() => void perform(() => discard({ id: request.id }))}
                >
                  Dismiss
                </Button>
              </div>
            </Panel>
          ))}
          {identity.accounts.length === 0 ? (
            <Empty title="No GitHub accounts linked">
              Link the account that owns your repositories. You choose the account on GitHub and
              confirm it here before anything is saved.
            </Empty>
          ) : (
            <Panel>
              <ul className="flex flex-col divide-y divide-hairline">
                {identity.accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:gap-5"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-hairline">
                      <GitHubMark className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{account.login}</p>
                      <p className="text-[14px] text-muted">
                        {account.installations.length
                          ? `App installed on ${account.installations.map((item) => item.login).join(", ")}`
                          : "Install the Vectis GitHub App on this account, then link it again."}
                        {" · "}Verified {relative(account.verifiedAt)}
                      </p>
                    </div>
                    {account.installations.length ? (
                      <Status tone="success">App installed</Status>
                    ) : (
                      <Status tone="attention">App not installed</Status>
                    )}
                    <ActionMenu
                      label={`Actions for ${account.login}`}
                      trigger={<EllipsisIcon className="size-4" />}
                      items={[
                        {
                          label: "Unlink this account",
                          danger: true,
                          onSelect: () => setUnlinking(account),
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
      <Confirm
        open={unlinking !== null}
        onOpenChange={(open) => setUnlinking(open ? unlinking : null)}
        title={unlinking ? `Unlink ${unlinking.login}?` : "Unlink this account"}
        description={unlinkDescription(
          bindings?.filter((binding) => binding.accountId === unlinking?.id).length ?? 0,
        )}
        phrase="unlink"
        label="Unlink account"
        onConfirm={async () => {
          if (unlinking) await unlink({ id: unlinking.id });
        }}
      />
    </>
  );
}

function unlinkDescription(connections: number) {
  return `Vectis forgets this GitHub identity${
    connections
      ? ` and disconnects ${connections} repository ${connections === 1 ? "connection" : "connections"} that rely on it`
      : ""
  }. The Vectis GitHub App stays installed until you remove it on GitHub.`;
}
