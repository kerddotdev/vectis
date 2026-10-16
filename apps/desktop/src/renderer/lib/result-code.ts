import type { Tone } from "@/components/status";

<<<<<<< HEAD
const githubCodes = new Set(["github_unavailable", "github_rate_limited"]);

export function resultCodePresentation(result: unknown): { tone: Tone; label: string } | undefined {
  if (typeof result !== "object" || !result || !("code" in result)) return undefined;
  if (typeof result.code !== "string" || !githubCodes.has(result.code)) return undefined;
  return { tone: "attention", label: "GitHub degraded" };
=======
const codes: Record<string, readonly [Tone, string]> = {
  runner_recovery_pending: ["attention", "Recovering after restart"],
  runner_interrupted: ["cancelled", "Interrupted"],
  runner_registration_failed: ["danger", "Registration failed"],
  runner_offline: ["danger", "Runner offline"],
};

export function resultCodePresentation(result: unknown) {
  if (typeof result !== "object" || !result || !("code" in result)) return undefined;
  if (typeof result.code !== "string" || !Object.hasOwn(codes, result.code)) return undefined;
  const [tone, label] = codes[result.code]!;
  return { tone, label };
>>>>>>> fix/runner-self-recovery
}
