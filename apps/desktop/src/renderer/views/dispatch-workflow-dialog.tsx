import { useRef, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type InputRow,
  inputsRecord,
  maxDispatchInputs,
  validateInputs,
  validateRef,
  validateWorkflow,
} from "@/lib/run-control";
import { useStateApi } from "@/state";

export function DispatchWorkflowDialog({
  bindingId,
  open,
  onOpenChange,
}: {
  bindingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { submit } = useStateApi();
  const [workflow, setWorkflow] = useState("");
  const [ref, setRef] = useState("");
  const [rows, setRows] = useState<InputRow[]>([]);
  const [touched, setTouched] = useState(false);
  const nextId = useRef(1);
  const workflowError = validateWorkflow(workflow);
  const refError = validateRef(ref);
  const rowErrors = validateInputs(rows);
  const invalid = workflowError !== undefined || refError !== undefined || rowErrors.size > 0;
  const update = (id: number, patch: Partial<InputRow>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>
            Starts a new run of one workflow on a branch or tag.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (invalid) return;
            const inputs = inputsRecord(rows);
            void submit({
              type: "workflow.dispatch",
              bindingId,
              workflow: workflow.trim(),
              ref: ref.trim(),
              ...(rows.length > 0 ? { inputs } : {}),
            }).then((value) => {
              if (value !== undefined) onOpenChange(false);
            });
          }}
        >
          <Field data-invalid={touched && workflowError !== undefined}>
            <FieldLabel htmlFor={`${bindingId}-workflow`}>Workflow file</FieldLabel>
            <Input
              id={`${bindingId}-workflow`}
              value={workflow}
              placeholder="ci.yml"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={touched && workflowError !== undefined}
              onChange={(event) => setWorkflow(event.target.value)}
            />
            {touched && workflowError && <FieldError>{workflowError}</FieldError>}
          </Field>
          <Field data-invalid={touched && refError !== undefined}>
            <FieldLabel htmlFor={`${bindingId}-ref`}>Branch or tag</FieldLabel>
            <Input
              id={`${bindingId}-ref`}
              value={ref}
              placeholder="main"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={touched && refError !== undefined}
              onChange={(event) => setRef(event.target.value)}
            />
            {touched && refError && <FieldError>{refError}</FieldError>}
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Inputs</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={rows.length >= maxDispatchInputs}
                onClick={() =>
                  setRows((current) => [...current, { id: nextId.current++, key: "", value: "" }])
                }
              >
                <PlusIcon />
                Add input
              </Button>
            </div>
            {rows.map((row, index) => {
              const error = touched ? rowErrors.get(row.id) : undefined;
              return (
                <div key={row.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      placeholder="name"
                      aria-label={`Input ${index + 1} name`}
                      aria-invalid={error !== undefined}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update(row.id, { key: event.target.value })}
                    />
                    <Input
                      value={row.value}
                      placeholder="value"
                      aria-label={`Input ${index + 1} value`}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update(row.id, { value: event.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove input ${index + 1}`}
                      onClick={() => setRows((current) => current.filter((it) => it.id !== row.id))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  {error && <FieldError>{error}</FieldError>}
                </div>
              );
            })}
            <FieldDescription>The workflow must have a workflow_dispatch trigger.</FieldDescription>
          </div>
          <div className="flex justify-end">
            <Button type="submit">Run workflow</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
