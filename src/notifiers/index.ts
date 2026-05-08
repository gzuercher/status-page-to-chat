import type { Notifier } from "../lib/types.js";
import type { AppConfig } from "../lib/config.js";
import { GoogleChatNotifier } from "./googleChat.js";
import { TeamsNotifier } from "./teams.js";

/**
 * Builds the notifier matching the configured chatTarget.
 */
export function createNotifier(config: AppConfig): Notifier {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL is not set");
  }

  switch (config.chatTarget) {
    case "googleChat":
      return new GoogleChatNotifier(webhookUrl);
    case "teams":
      return new TeamsNotifier(webhookUrl);
  }
}
