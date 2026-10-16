import type { Tone } from "@/components/status";

const githubCodes = new Set(["github_unavailable", "github_rate_limited"]);

export function resultCodePresentation(result: unknown): { tone: Tone; label: string } | undefined {
  if (typeof result !== "object" || !result || !("code" in result)) return undefined;
  if (typeof result.code !== "string" || !githubCodes.has(result.code)) return undefined;
  return { tone: "attention", label: "GitHub degraded" };
}
