import type { Notifier } from "../lib/types.js";
import type { AppConfig } from "../lib/config.js";
import { TeamsJsonNotifier } from "./teamsJson.js";

/**
 * Builds the notifier matching the configured chatTarget.
 *
 * There is exactly one target left. Earlier versions also shipped
 * notifiers that rendered a finished Adaptive Card (`teams`) and a Google
 * Chat card (`googleChat`); both were removed once the Azure Logic App
 * took over rendering centrally, because keeping three card layouts in
 * sync for one deployment that used none of them was pure cost.
 */
export function createNotifier(config: AppConfig): Notifier {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL is not set");
  }

  return new TeamsJsonNotifier(webhookUrl, config.language);
}
