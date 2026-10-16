import type { Tone } from "@/components/status";

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
}
