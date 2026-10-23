export type SortableProfile = {
  id: string;
  name: string;
  groupId?: string | null;
  sortOrder?: number;
};

export function profileDropInsertionIndex(
  profiles: SortableProfile[],
  draggedId: string,
  targetId: string,
) {
  if (draggedId === targetId) return null;

  const target = profiles.find((profile) => profile.id === targetId);
  if (!target) return null;

  const targetGroupId = target.groupId ?? null;
  const siblings = profiles
    .filter((profile) => (profile.groupId ?? null) === targetGroupId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const dragged = profiles.find((profile) => profile.id === draggedId);
  if (!dragged) return null;
  const targetIndex = siblings.findIndex((profile) => profile.id === targetId);
  const draggedIndex = (dragged.groupId ?? null) === targetGroupId
    ? siblings.findIndex((profile) => profile.id === draggedId)
    : -1;

  return targetIndex - (draggedIndex >= 0 && draggedIndex < targetIndex ? 1 : 0);
}
