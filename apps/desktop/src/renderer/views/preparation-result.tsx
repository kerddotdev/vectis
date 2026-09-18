import { Schema } from "effect";
import { useState } from "react";
import { Details, Mono } from "@/components/layout";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useStateApi } from "@/state";

const Progress = Schema.Struct({
  setupId: Schema.String,
  receivedBytes: Schema.optional(Schema.Number),
  directory: Schema.optional(Schema.String),
  restoreDirectory: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
});

export function PreparationResult({
  result,
  resumable,
  macos = false,
  windows = false,
}: {
  result: unknown;
  resumable: boolean;
  macos?: boolean;
  windows?: boolean;
}) {
  const { submit } = useStateApi();
  const [confirmation, setConfirmation] = useState("");
  if (!Schema.is(Progress)(result)) return null;
  const discardable =
    macos && resumable && ["setup_required", "interrupted"].includes(result.phase ?? "");
  const actions = [
    macos && result.phase === "setup_running",
    macos && result.phase === "ssh_enrollment",
    macos && result.phase === "ssh_verified",
    macos && result.phase === "setup_required",
    resumable && (!macos || result.phase === "interrupted"),
  ].some(Boolean);
  const details = (
    <Details
      items={[
        ["Downloaded", result.receivedBytes !== undefined && formatBytes(result.receivedBytes)],
        ["Image directory", result.directory && <Mono>{result.directory}</Mono>],
        ["Restore download", result.restoreDirectory && <Mono>{result.restoreDirectory}</Mono>],
      ]}
    />
  );
  if (!result.nextStep && !actions && !discardable) return details;
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-muted/60 px-4 py-3.5">
      {result.nextStep && (
        <p className="font-medium" data-selectable>
          {result.nextStep}
        </p>
      )}
      {details}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {macos && result.phase === "setup_running" && (
          <Button
            size="sm"
            onClick={() =>
              void submit({
                type: "environment.connect-macos-guest",
                id: result.setupId,
                openTerminal: true,
              })
            }
          >
            Connect guest SSH on host
          </Button>
        )}
        {macos && result.phase === "ssh_enrollment" && (
          <Button
            size="sm"
            onClick={() =>
              void submit({ type: "environment.verify-macos-guest", id: result.setupId })
            }
          >
            Verify guest SSH
          </Button>
        )}
        {macos && result.phase === "ssh_verified" && (
          <Button
            size="sm"
            onClick={() =>
              void submit({ type: "environment.finish-macos-setup", id: result.setupId })
            }
          >
            Finish macOS setup
          </Button>
        )}
        {macos && result.phase === "setup_required" && (
          <Button
            size="sm"
            onClick={() =>
              void submit({ type: "environment.open-macos-setup", id: result.setupId })
            }
          >
            Open guest setup console
          </Button>
        )}
        {resumable && (!macos || result.phase === "interrupted") && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void submit({
                type: macos
                  ? "environment.resume-macos"
                  : windows
                    ? "environment.resume-windows"
                    : "environment.resume",
                id: result.setupId,
              })
            }
          >
            Resume preparation
          </Button>
        )}
      </div>
      {discardable && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({
              type: "environment.discard-macos",
              id: result.setupId,
              environmentId: confirmation.trim(),
            });
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor={`discard-${result.setupId}`}>
              Type the environment ID to permanently discard this unregistered setup
            </FieldLabel>
            <Input
              id={`discard-${result.setupId}`}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="destructive" size="sm" disabled={!confirmation.trim()}>
            Discard setup files
          </Button>
        </form>
      )}
    </div>
  );
}
