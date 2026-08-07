import type { Notifier } from "../lib/types.js";
import type { AppConfig } from "../lib/config.js";
import type { Store } from "../state/store.js";
import { createTranslator } from "../lib/translator.js";
import { TeamsJsonNotifier } from "./teamsJson.js";

/**
 * Builds the notifier matching the configured chatTarget.
 *
 * There is exactly one target left. Earlier versions also shipped
 * notifiers that rendered a finished Adaptive Card (`teams`) and a Google
 * Chat card (`googleChat`); both were removed once the Azure Logic App
 * took over rendering centrally, because keeping three card layouts in
 * sync for one deployment that used none of them was pure cost.
 *
 * The translator is built here rather than inside the notifier so it can
 * share the SQLite store: incident titles repeat between the "opened" and
 * "resolved" notification, and the cache turns the second one into a
 * lookup instead of an API call.
 */
export function createNotifier(config: AppConfig, store: Store): Notifier {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL is not set");
  }

  return new TeamsJsonNotifier(
    webhookUrl,
    config.language,
    createTranslator(config.language, store),
  );
}
