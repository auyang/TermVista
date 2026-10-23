export function getUiFontScale() {
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale"));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
