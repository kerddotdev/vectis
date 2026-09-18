import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useStateApi } from "@/state";

export function PathField({
  label,
  value,
  onChange,
  chooser,
  name,
  required,
  placeholder,
  description,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  chooser: "chooseDirectory" | "chooseFile" | "chooseRestoreImage";
  name?: string;
  required?: boolean;
  placeholder?: string;
  description?: string;
}) {
  const { perform, machineId } = useStateApi();
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono text-[12px]"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(name ? { name } : {})}
          {...(required ? { required } : {})}
          {...(placeholder ? { placeholder } : {})}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={!!machineId}
          aria-label={`Choose ${label}`}
          onClick={() =>
            void perform(chooser).then((picked) => {
              if (typeof picked === "string") onChange(picked);
            })
          }
        >
          Choose…
        </Button>
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
