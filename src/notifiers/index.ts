import type { Notifier } from "../lib/types.js";
import type { AppConfig } from "../lib/config.js";
import type { Store } from "../state/store.js";
import { createTranslator } from "../lib/translator.js";
import { GoogleChatNotifier } from "./googleChat.js";
import { TeamsNotifier } from "./teams.js";
import { TeamsJsonNotifier } from "./teamsJson.js";

/**
 * Builds the notifier matching the configured chatTarget.
 *
 * The Teams notifier renders localised, machine-translated cards, so it
 * receives a Translator (built from `ANTHROPIC_API_KEY` + `config.language`)
 * and the target locale. The translator caches in the shared SQLite store.
 *
 * The `teamsJson` target POSTs the raw normalized event as JSON instead of a
 * card, so a downstream renderer (e.g. an Azure Logic App) builds the card
 * centrally. It needs no translator — presentation is the consumer's job.
 */
export function createNotifier(config: AppConfig, store: Store): Notifier {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL is not set");
  }

  switch (config.chatTarget) {
    case "googleChat":
      return new GoogleChatNotifier(webhookUrl);
    case "teams":
      return new TeamsNotifier(
        webhookUrl,
        createTranslator(config.language, store),
        config.language,
      );
    case "teamsJson":
      return new TeamsJsonNotifier(webhookUrl, config.language);
  }
}
