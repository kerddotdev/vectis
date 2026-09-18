import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export interface MigrationTarget {
  readonly from: string;
  readonly to: string;
}
export interface MigrationFinding {
  readonly job: string;
  readonly reason: string;
}
export interface MigrationPreview {
  readonly changed: boolean;
  readonly source: string;
  readonly findings: readonly MigrationFinding[];
}

export function previewMigration(
  source: string,
  targets: readonly MigrationTarget[],
): MigrationPreview {
  const document = parseDocument(source, { uniqueKeys: true });
  const findings: MigrationFinding[] = [];
  if (document.errors.length > 0 || !isMap(document.contents))
    return {
      changed: false,
      source,
      findings: [{ job: "workflow", reason: "Invalid workflow YAML." }],
    };
  const trigger = document.get("on", true);
  const unsafe = isScalar(trigger)
    ? ["pull_request_target", "workflow_run"].includes(String(trigger.value))
    : isSeq(trigger)
      ? trigger.items.some(
          (item) =>
            isScalar(item) && ["pull_request_target", "workflow_run"].includes(String(item.value)),
        )
      : isMap(trigger) && (trigger.has("pull_request_target") || trigger.has("workflow_run"));
  if (unsafe)
    return {
      changed: false,
      source,
      findings: [{ job: "workflow", reason: "Privileged event requires manual review." }],
    };
  const jobs = document.get("jobs", true);
  if (!isMap(jobs))
    return {
      changed: false,
      source,
      findings: [{ job: "workflow", reason: "No jobs mapping found." }],
    };
  const mapping = new Map(targets.map((target) => [target.from, target.to]));
  let changed = false;
  for (const entry of jobs.items) {
    const name = isScalar(entry.key) ? String(entry.key.value) : "unknown";
    if (!isMap(entry.value)) continue;
    if (entry.value.has("uses")) {
      findings.push({
        job: name,
        reason: "Reusable workflow requires review in its owning repository.",
      });
      continue;
    }
    const runner = entry.value.get("runs-on", true);
    if (!isScalar(runner) || typeof runner.value !== "string") {
      findings.push({ job: name, reason: "Non-scalar runner selection requires manual review." });
      continue;
    }
    const current = runner.value;
    const replace = (label: string): string | undefined => {
      const target = mapping.get(label);
      if (!target) return undefined;
      if (
        ![
          "ubuntu-24.04-arm",
          "ubuntu-22.04-arm",
          "windows-11-arm",
          "macos-14",
          "macos-15",
          "macos-26",
          "macos-latest",
        ].includes(label)
      ) {
        findings.push({
          job: name,
          reason: `Architecture compatibility is not established for ${label}.`,
        });
        return undefined;
      }
      if (!/^vectis-[a-z0-9][a-z0-9-]*$/.test(target)) {
        findings.push({ job: name, reason: "Target must be a Vectis label." });
        return undefined;
      }
      return target;
    };
    const expression = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(current);
    if (expression?.[1]) {
      const matrix = entry.value.getIn(["strategy", "matrix"], true);
      const values = isMap(matrix) ? matrix.get(expression[1], true) : undefined;
      if (
        !isMap(matrix) ||
        matrix.has("include") ||
        matrix.has("exclude") ||
        !isSeq(values) ||
        values.items.some((value) => !isScalar(value) || typeof value.value !== "string")
      ) {
        findings.push({ job: name, reason: "Dynamic or expanded matrix requires manual review." });
        continue;
      }
      for (const value of values.items)
        if (isScalar(value) && typeof value.value === "string") {
          const target = replace(value.value);
          if (target && target !== value.value) {
            value.value = target;
            changed = true;
          }
        }
    } else if (current.includes("${{"))
      findings.push({ job: name, reason: "Dynamic runner expression requires manual review." });
    else {
      const target = replace(current);
      if (target && target !== current) {
        runner.value = target;
        changed = true;
      }
    }
  }
  return { changed, source: changed ? document.toString() : source, findings };
}
