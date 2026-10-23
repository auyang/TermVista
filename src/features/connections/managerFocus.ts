let managerOpener: HTMLElement | null = null;

export function rememberManagerOpener(target: HTMLElement | null) {
  managerOpener = target;
}

export function takeManagerOpener() {
  const target = managerOpener;
  managerOpener = null;
  return target;
}
