import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { RepositoryReadiness } from "../../../../../packages/protocol/src/readiness.js";
import { GitHubAccounts } from "../../../../../packages/protocol/src/repositories.js";
import { Reason } from "@/components/hint";
import { Notice } from "@/components/layout";
import { ReadinessList } from "@/components/readiness";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readinessFailure, summarizeReadiness } from "@/lib/readiness";
import { cn } from "@/lib/utils";
import { request, useStateApi } from "@/state";

const fullName = /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

function useReadiness(repositoryName: string, environmentId: string) {
  const { machineId } = useStateApi();
  const key =
    fullName.test(repositoryName) && environmentId ? `${repositoryName}:${environmentId}` : "";
  const [focus, setFocus] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    token: string;
    readiness?: RepositoryReadiness;
    error?: string;
    unavailable?: boolean;
  }>();
  const latest = useRef("");
  const token = `${machineId ?? ""}:${key}#${focus}`;
  useEffect(() => {
    const again = () => setFocus((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    latest.current = token;
    if (!key) return;
    const timer = setTimeout(() => {
      request("repository.readiness", { repositoryName, environmentId }, machineId)
        .then((value) => {
          const readiness = Schema.decodeUnknownSync(RepositoryReadiness)(value);
          if (latest.current === token) setResult({ key, token, readiness });
        })
        .catch((issue: unknown) => {
          if (latest.current === token)
            setResult({
              key,
              token,
              ...readinessFailure(issue),
            });
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [token]);
  const current = key && result?.key === key ? result : undefined;
  // Connecting creates the binding, so its absence is expected here rather than a problem.
  const checks = current?.readiness?.checks.filter(
    (check) => !(check.id === "repository.binding" && check.code === "binding_missing"),
  );
  return {
    checking: !!key && result?.token !== token,
    checks,
    error: current?.error,
    unavailable: current?.unavailable,
    blocking: checks && summarizeReadiness(checks).blocking,
  };
}

export function ConnectRepository({ onDone }: { onDone: () => void }) {
  const { snapshot, perform, submit } = useStateApi();
  const [accounts, setAccounts] = useState<GitHubAccounts | null>(null);
  const [accountId, setAccountId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void perform("github.accounts")
      .then((result) => {
        if (result === undefined) return;
        const available = Schema.decodeUnknownSync(GitHubAccounts)(result);
        setAccounts(available);
        if (!available.length) setMessage("Connect a GitHub account in the browser first.");
      })
      .catch(() => setMessage("GitHub accounts could not be read."));
  }, []);
  const environments =
    snapshot?.environments.filter((environment) => environment.state === "ready") ?? [];
  const owner = repositoryOwner || accounts?.find((account) => account.id === accountId)?.login;
  const readiness = useReadiness(
    accountId && owner && repositoryName ? `${owner}/${repositoryName}` : "",
    environmentId,
  );
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void submit({
          type: "repository.connect",
          accountId,
          repositoryName,
          ...(repositoryOwner ? { repositoryOwner } : {}),
          environmentId,
        })
          .then((result) => result !== undefined && onDone())
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="contents">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>GitHub account</FieldLabel>
            <Select
              value={accountId || null}
              onValueChange={(value: string | null) => setAccountId(value ?? "")}
              items={(accounts ?? []).map((account) => ({
                value: account.id,
                label: account.login,
              }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={accounts ? "Select an account" : "Loading verified accounts"}
                />
              </SelectTrigger>
              <SelectContent>
                {accounts?.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.login}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="repository-owner">Owner</FieldLabel>
              <Input
                id="repository-owner"
                value={repositoryOwner}
                pattern="[A-Za-z0-9-]+"
                onChange={(event) => setRepositoryOwner(event.target.value)}
                placeholder="Selected account"
              />
              <FieldDescription>Only for an organization repository.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="repository-name">Repository</FieldLabel>
              <Input
                id="repository-name"
                required
                pattern="[A-Za-z0-9_.-]+"
                value={repositoryName}
                onChange={(event) => setRepositoryName(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel>Prepared environment</FieldLabel>
            <Select
              value={environmentId || null}
              onValueChange={(value: string | null) => setEnvironmentId(value ?? "")}
              items={environments.map((environment) => ({
                value: environment.id,
                label: environment.name,
              }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        {message && <Notice>{message}</Notice>}
        {readiness.unavailable ? (
          <p className="text-xs text-muted-foreground">
            Readiness unavailable on this machine. Update its Vectis service to see checks.
          </p>
        ) : readiness.error ? (
          <Notice tone="attention" title="Readiness could not be checked">
            {readiness.error}
          </Notice>
        ) : readiness.checks ? (
          <ReadinessList
            checks={readiness.checks}
            className={cn(
              "rounded-xl ring-1 ring-border ring-inset transition-opacity duration-150",
              readiness.checking && "opacity-60",
            )}
          />
        ) : (
          readiness.checking && (
            <p className="text-xs text-muted-foreground" role="status">
              Checking whether this repository can run here
            </p>
          )
        )}
        <div className="flex justify-end">
          <Reason
            reason={
              readiness.blocking && (readiness.blocking.nextStep ?? readiness.blocking.message)
            }
          >
            <Button type="submit" disabled={!accountId || !environmentId || !!readiness.blocking}>
              Connect repository
            </Button>
          </Reason>
        </div>
      </fieldset>
    </form>
  );
}
