type OscParser = {
  registerOscHandler: (code: number, handler: (data: string) => boolean) => { dispose: () => void };
};

export function blockOsc52ClipboardWrites(parser: OscParser) {
  // OSC 52 可由远端程序请求改写本机剪贴板；本产品不提供该能力，始终消费并丢弃请求。
  return parser.registerOscHandler(52, () => true);
}

export function safeExternalLinkTarget(target: string): string | null {
  try {
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
