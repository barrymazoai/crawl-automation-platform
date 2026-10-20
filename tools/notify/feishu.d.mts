// Types for feishu.mjs, so the TypeScript worker sends its cards through the same sender (KAN-220).
export interface FeishuCard {
  title: string;
  markdown: string;
  /** Feishu header template, e.g. "red", "orange", "green". */
  color: string;
}

export interface FeishuNotifier {
  enabled: boolean;
  send(card: FeishuCard): Promise<{ sent: true } | { sent: false; reason: string }>;
}

export function feishuNotifier(
  file: string | null | undefined,
  options: {
    log: {
      warn(context: object, message: string): void;
      error(context: object, message: string): void;
    };
  },
): Promise<FeishuNotifier>;
