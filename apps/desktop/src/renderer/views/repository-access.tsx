import { useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import type { RepositoryAccess } from "../../../../../packages/protocol/src/repository-access.js";
import { Mono } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addActorId, canSaveAccess, defaultAccess, maxActorIds } from "@/lib/repository-access";
import { useStateApi } from "@/state";

type Binding = MachineRepositories[number];

export function RepositoryAccessEditor({
  binding,
  label,
  repositoryName,
}: {
  binding: Binding;
  label: string;
  repositoryName: string;
}) {
  const { submit } = useStateApi();
  const saved = binding.access ?? defaultAccess;
  const [draft, setDraft] = useState<RepositoryAccess>(saved);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const ids = draft.actors === "any" ? [] : draft.actors.ids;
  function add() {
    const result = addActorId(ids, text);
    if ("error" in result) return setError(result.error);
    setDraft({ ...draft, actors: { ids: result.ids } });
    setText("");
    setError(undefined);
  }
  async function save() {
    setSaving(true);
    try {
      await submit(
        { type: "repository.access", bindingId: binding.id, ...draft },
        `Access updated for ${repositoryName}`,
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col gap-4 rounded-xl px-3.5 py-3 ring-1 ring-border ring-inset">
      <p className="font-medium">{label}</p>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Who can start runners</p>
        <Tabs
          value={draft.actors === "any" ? "any" : "ids"}
          onValueChange={(value) =>
            setDraft({ ...draft, actors: value === "any" ? "any" : { ids } })
          }
        >
          <TabsList aria-label="Who can start runners" className="h-auto flex-wrap">
            <TabsTrigger value="any">Anyone who can run workflows</TabsTrigger>
            <TabsTrigger value="ids">Only these GitHub users</TabsTrigger>
          </TabsList>
        </Tabs>
        {draft.actors !== "any" && (
          <div className="flex flex-col gap-2">
            {ids.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {ids.map((id) => (
                  <li
                    key={id}
                    className="inline-flex h-6 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 font-mono text-xs"
                  >
                    {id}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-4 rounded-full"
                      aria-label={`Remove GitHub user ${id}`}
                      onClick={() =>
                        setDraft({ ...draft, actors: { ids: ids.filter((item) => item !== id) } })
                      }
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                Add at least one user. Nobody else could start a runner.
              </p>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <Input
                value={text}
                inputMode="numeric"
                placeholder="GitHub user ID"
                aria-label="GitHub user ID"
                aria-invalid={!!error}
                disabled={ids.length >= maxActorIds}
                className="max-w-48"
                onChange={(event) => {
                  setText(event.target.value);
                  setError(undefined);
                }}
              />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={!text.trim() || ids.length >= maxActorIds}
              >
                <PlusIcon />
                Add
              </Button>
            </form>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Use numeric GitHub user IDs. Find one with:{" "}
              <Mono>gh api users/&lt;login&gt; --jq .id</Mono>
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
          Approve each job before it runs on this Mac
          <Switch
            size="sm"
            checked={draft.approval === "required"}
            onCheckedChange={(required) =>
              setDraft({ ...draft, approval: required ? "required" : "automatic" })
            }
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Jobs wait under Needs you until you start them.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-[52ch] text-xs text-muted-foreground">
          Vectis checks the job again inside the VM after GitHub assigns it and stops the runner if
          it does not match.
        </p>
        <Button
          size="sm"
          disabled={saving || !canSaveAccess(saved, draft)}
          onClick={() => void save()}
        >
          {saving ? "Saving" : "Save access"}
        </Button>
      </div>
    </div>
  );
}
