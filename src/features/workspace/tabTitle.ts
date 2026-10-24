export function getWorkspaceTabDisplayTitle(
  tab: { mode: string; title: string },
  blankTabLabel: string,
) {
  return tab.mode === "blank" ? blankTabLabel : tab.title;
}
