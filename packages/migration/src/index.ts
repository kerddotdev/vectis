import { isAlias, isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import type { MigrationJob } from "../../protocol/src/migrations.js";

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
  readonly jobs?: readonly MigrationJob[];
}

interface ScalarReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function scalarReplacement(
  source: string,
  node: Scalar,
  target: string,
): ScalarReplacement | undefined {
  const token = node.srcToken;
  const range = node.range;
  if (
    node.anchor ||
    node.tag ||
    !range ||
    !token ||
    !["scalar", "single-quoted-scalar", "double-quoted-scalar"].includes(token.type) ||
    !("source" in token)
  )
    return undefined;
  const [start, end] = range;
  if (
    token.offset !== start ||
    end <= start ||
    source.slice(start, end) !== token.source ||
    /[\r\n]/.test(token.source)
  )
    return undefined;
  const quote =
    token.type === "single-quoted-scalar" ? "'" : token.type === "double-quoted-scalar" ? '"' : "";
  return { start, end, text: quote + target + quote };
}

function staticNeeds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (isScalar(value) && typeof value.value === "string" && !value.value.includes("${{"))
    return [value.value];
  if (!isSeq(value)) return undefined;
  const needs: string[] = [];
  for (const item of value.items) {
    if (!isScalar(item) || typeof item.value !== "string" || item.value.includes("${{"))
      return undefined;
    needs.push(item.value);
  }
  return needs;
}

export function previewMigration(
  source: string,
  targets: readonly MigrationTarget[],
): MigrationPreview {
  const document = parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
  const findings: MigrationFinding[] = [];
  if (document.errors.length > 0 || !isMap(document.contents))
    return {
      changed: false,
      source,
      findings: [{ job: "workflow", reason: "Invalid workflow YAML." }],
    };
  const trigger = document.get("on", true);
  if (isAlias(trigger) || (isSeq(trigger) && trigger.items.some(isAlias)))
    return {
      changed: false,
      source,
      findings: [{ job: "workflow", reason: "Aliased workflow events require manual review." }],
    };
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
  const replacements: ScalarReplacement[] = [];
  const summaries: MigrationJob[] = [];
  for (const entry of jobs.items) {
    const name = isScalar(entry.key) ? String(entry.key.value) : "unknown";
    const reasons: string[] = [];
    const needs = isMap(entry.value) ? staticNeeds(entry.value.get("needs", true)) : undefined;
    const jobTargets: string[] = [];
    const summary = {
      job: name,
      changed: false,
      reasons,
      targets: jobTargets,
      ...(needs ? { needs } : {}),
    };
    summaries.push(summary);
    const finding = (reason: string) => {
      findings.push({ job: name, reason });
      reasons.push(reason);
    };
    const splice = (node: Scalar, target: string) => {
      if (target === node.value) return;
      const replacement = scalarReplacement(source, node, target);
      if (!replacement) {
        finding("Runner scalar cannot be safely replaced without affecting formatting or aliases.");
        return;
      }
      replacements.push(replacement);
      if (!jobTargets.includes(target)) jobTargets.push(target);
      summary.changed = true;
    };
    if (!isMap(entry.value)) {
      finding("Non-mapping job requires manual review.");
      continue;
    }
    if (entry.value.has("uses")) {
      finding("Reusable workflow requires review in its owning repository.");
      continue;
    }
    if (entry.value.anchor) {
      finding("Anchored job requires manual review.");
      continue;
    }
    const runner = entry.value.get("runs-on", true);
    if (!isScalar(runner) || typeof runner.value !== "string") {
      finding("Non-scalar runner selection requires manual review.");
      continue;
    }
    const current = runner.value;
    const replace = (label: string): string | undefined => {
      const target = mapping.get(label);
      if (!target) {
        if (/^vectis-[a-z0-9][a-z0-9-]*$/.test(label))
          finding(
            `Already runs on ${label}. Migration only replaces GitHub-hosted labels, so an existing Vectis label stays as it is.`,
          );
        else reasons.push(`No migration target configured for ${label}.`);
        return undefined;
      }
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
        finding(`Architecture compatibility is not established for ${label}.`);
        return undefined;
      }
      if (!/^vectis-[a-z0-9][a-z0-9-]*$/.test(target)) {
        finding("Target must be a Vectis label.");
        return undefined;
      }
      return target;
    };
    const expression = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(current);
    if (expression?.[1]) {
      const strategy = entry.value.get("strategy", true);
      const matrix = isMap(strategy) ? strategy.get("matrix", true) : undefined;
      const values = isMap(matrix) ? matrix.get(expression[1], true) : undefined;
      if (
        !isMap(matrix) ||
        matrix.has("include") ||
        matrix.has("exclude") ||
        !isSeq(values) ||
        values.items.some((value) => !isScalar(value) || typeof value.value !== "string")
      ) {
        finding("Dynamic or expanded matrix requires manual review.");
        continue;
      }
      if ((isMap(strategy) && strategy.anchor) || matrix.anchor || values.anchor) {
        finding("Anchored runner matrix requires manual review.");
        continue;
      }
      for (const value of values.items)
        if (isScalar(value) && typeof value.value === "string") {
          const target = replace(value.value);
          if (target) splice(value, target);
        }
    } else if (current.includes("${{"))
      finding("Dynamic runner expression requires manual review.");
    else {
      const target = replace(current);
      if (target) splice(runner, target);
    }
  }
  let rewritten = source;
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start))
    rewritten = rewritten.slice(0, start) + text + rewritten.slice(end);
  return { changed: replacements.length > 0, source: rewritten, findings, jobs: summaries };
}
