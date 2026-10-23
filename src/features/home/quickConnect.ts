import type { ConnectionProfile } from "@/stores/workspaceStore";

export type ProfileFilter = "all" | "favorite" | "recent";

export function selectQuickConnectProfiles(
  profiles: readonly ConnectionProfile[],
  filter: ProfileFilter,
  search: string,
) {
  const term = search.trim().toLocaleLowerCase();
  return profiles
    .filter((profile) => filter === "favorite" ? profile.favorite : filter === "recent" ? Boolean(profile.lastConnectedAt) : true)
    .filter((profile) => !term || [profile.name, profile.host, profile.username].some((value) => value.toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite)
      || (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
