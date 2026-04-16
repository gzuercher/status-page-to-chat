import type { Notifier } from "../lib/types.js";
import type { AppConfig } from "../lib/config.js";
import { GoogleChatNotifier } from "./googleChat.js";
import { TeamsNotifier } from "./teams.js";

/**
 * Erstellt den passenden Notifier anhand der chatTarget-Konfiguration.
 */
export function createNotifier(config: AppConfig): Notifier {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL ist nicht gesetzt");
  }

  switch (config.chatTarget) {
    case "googleChat":
      return new GoogleChatNotifier(webhookUrl);
    case "teams":
      return new TeamsNotifier(webhookUrl);
  }
}
