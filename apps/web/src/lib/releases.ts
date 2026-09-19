import { z } from "astro/zod";
import { site } from "@vectis/design/site";

const GitHubRelease = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  // GitHub renders and sanitizes release notes, which include pull request titles from anyone.
  body_html: z.string().optional(),
  assets: z.array(z.object({ name: z.string(), size: z.number() })),
});

export interface Release {
  version: string;
  title: string;
  date: Date;
  html: string;
  prerelease: boolean;
  url: string;
  diskImageBytes: number | undefined;
}

const diskImage = new URL(site.download).pathname.split("/").at(-1);

async function load(): Promise<Release[]> {
  const repository = new URL(site.repository).pathname.slice(1);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.html+json",
    "User-Agent": "vectis-site",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=50`,
      {
        headers,
      },
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for the release list.`);
    return z
      .array(GitHubRelease)
      .parse(await response.json())
      .flatMap((release) =>
        release.draft || !release.published_at
          ? []
          : [
              {
                version: release.tag_name.replace(/^v/, ""),
                title: release.name || release.tag_name,
                date: new Date(release.published_at),
                html: release.body_html ?? "",
                prerelease: release.prerelease,
                url: release.html_url,
                diskImageBytes: release.assets.find((asset) => asset.name === diskImage)?.size,
              },
            ],
      );
  } catch (error) {
    // Deploys must show real releases; local previews may run offline.
    if (process.env.CI) throw error;
    console.warn(`Releases are unavailable: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

let cached: Promise<Release[]> | undefined;

export function releases() {
  cached ??= load();
  return cached;
}

export async function latestRelease() {
  return (await releases()).find((release) => !release.prerelease);
}
