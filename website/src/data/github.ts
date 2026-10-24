import { env } from 'node:process';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface LatestRelease {
  tag: string;
  url: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

let latestRelease: Promise<LatestRelease | null> | undefined;

export function getLatestRelease(): Promise<LatestRelease | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  latestRelease ??= fetch('https://api.github.com/repos/auyang/TermVista/releases/latest', {
    headers,
    signal: AbortSignal.timeout(8000),
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') return null;
      const release = result as Record<string, unknown>;
      if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string' || typeof release.published_at !== 'string') return null;
      const assets = Array.isArray(release.assets) ? release.assets.flatMap((asset): ReleaseAsset[] => {
        if (!asset || typeof asset !== 'object') return [];
        const item = asset as Record<string, unknown>;
        if (typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') return [];
        return [{ name: item.name, url: item.browser_download_url, size: typeof item.size === 'number' ? item.size : 0 }];
      }) : [];
      return { tag: release.tag_name, url: release.html_url, publishedAt: release.published_at, assets };
    })
    .catch(() => null);
  return latestRelease;
}
