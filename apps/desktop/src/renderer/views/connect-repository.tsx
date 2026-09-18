import { useEffect, useState } from "react";
import { Schema } from "effect";
import { GitHubAccounts } from "../../../../../packages/protocol/src/repositories.js";
import { Notice } from "@/components/layout";
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
import { useStateApi } from "@/state";

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
        <div className="flex justify-end">
          <Button type="submit" disabled={!accountId || !environmentId}>
            Connect repository
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
