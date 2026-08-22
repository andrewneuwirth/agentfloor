/**
 * Outbound notifiers. Credentials come from the environment only — the
 * config file names the adapter, never holds a secret.
 *
 *   slack:    SLACK_WEBHOOK_URL   (an Incoming Webhook URL)
 *   telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 */
import type { EventSeverity, Notifier } from "@agentfloor/engine";

const TAG: Record<EventSeverity, string> = {
  info: "[INFO]",
  success: "[OK]",
  warn: "[WARN]",
  error: "[FAIL]",
};

export class SlackNotifier implements Notifier {
  readonly name = "slack";
  private readonly url: string;

  constructor(opts: { webhookUrl?: string } = {}) {
    const url = opts.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    if (!url) throw new Error("slack notifier needs SLACK_WEBHOOK_URL in the environment (an Incoming Webhook URL)");
    this.url = url;
  }

  async notify(message: string, opts: { severity?: EventSeverity } = {}): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `${TAG[opts.severity ?? "info"]} AgentFloor: ${message}` }),
    });
    if (!res.ok) throw new Error(`slack webhook returned ${res.status}`);
  }
}

export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly apiBase: string;

  constructor(opts: { apiBase?: string } = {}) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      throw new Error("telegram notifier needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment");
    }
    this.token = token;
    this.chatId = chatId;
    this.apiBase = opts.apiBase ?? "https://api.telegram.org";
  }

  async notify(message: string, opts: { severity?: EventSeverity } = {}): Promise<void> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: `${TAG[opts.severity ?? "info"]} AgentFloor: ${message}` }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage returned ${res.status}`);
  }
}
