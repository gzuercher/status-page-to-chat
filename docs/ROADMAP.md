# Roadmap

Die Umsetzung des Dienstes erfolgt in aufeinander aufbauenden Etappen. Jede Etappe ist so geschnitten, dass sie **einzeln reviewbar und lauffähig** ist.

Legende: `[ ]` offen · `[~]` in Arbeit · `[x]` erledigt

## Etappe 1 — Grundgerüst

- [x] `package.json` mit Dependencies: `@azure/functions`, `@azure/data-tables`, `zod`, `yaml`, `pino`, `undici`
- [x] Dev-Deps: `typescript`, `vitest`, `eslint`, `prettier`, `@types/node`
- [x] `tsconfig.json` (strict, target ES2022)
- [x] `host.json` (Functions v4)
- [x] `local.settings.json.example`
- [x] `eslint.config.mjs`, `.prettierrc`
- [x] Scripts: `build`, `test`, `lint`, `format`
- [x] `src/lib/types.ts` mit `NormalizedIncident`, `StatusProvider`, `Notifier`
- [x] `src/lib/logger.ts` (pino)

**Fertig**: `pnpm install && pnpm build` läuft durch.

## Etappe 2 — Config & State

- [x] `src/lib/config.ts`: YAML laden, zod-Schema, Umgebungsvariablen lesen
- [x] `config/providers.yaml` mit Starter-Einträgen (vorgezogen; enthält aktuell 19 Provider inkl. Atlassian-, Google-Workspace-, Metanet-, WEDOS- und GitHub-Issues-Einträge)
- [x] `src/state/tableStore.ts`: CRUD auf Azure Table Storage, Abgleich-Logik
- [x] `src/lib/httpClient.ts`: Zentraler HTTP-Client mit User-Agent und Timeout
- [x] Unit-Tests für State-Diff (6 Tests)

**Fertig**: Tests grün, State-Diff erkennt korrekt Neu/Behoben/Unverändert.

## Etappe 3 — Erster Adapter (Atlassian)

- [x] `src/adapters/atlassianStatuspage.ts`
- [x] `tests/adapters/atlassianStatuspage.test.ts` mit Fixture für offene + geschlossene Incidents
- [x] Komponenten-Filter-Logik: unterstützt sowohl `string` als auch `string[]` (OR-Logik). Tests für beide Formen + für „kein Filter"-Fall.
- [x] zod-Schema: `componentFilter: z.union([z.string(), z.array(z.string())]).optional()`
- [x] Status-Mapping-Test
- [x] Response-Validierung: Content-Type prüfen und JSON parsen in try/catch (9 Tests)

**Fertig**: Adapter gibt aus Fixture-Responses korrekt normalisierte Incidents zurück.

## Etappe 4 — Notifier

- [x] `src/notifiers/googleChat.ts` (Card v2)
- [x] `src/notifiers/teams.ts` (Adaptive Card)
- [x] Gemeinsames Interface in `src/notifiers/index.ts`
- [x] Tests mit Mock-Fetch, Payload-Struktur verifizieren (7 Tests)
- [x] Retry-Logik (1x Backoff, 2s) mit Test

**Fertig**: Nachrichtenformat und Retry-Logik durch Tests verifiziert.

## Etappe 5 — Orchestrierung

- [x] `src/functions/poll.ts` Timer Trigger
- [x] Fehlerisolation pro Provider (Promise.allSettled)
- [x] Strukturiertes `run_summary`-Log je Durchlauf
- [x] State-Abgleich mit Benachrichtigungs-Tracking (notifiedOpened/notifiedResolved)

**Fertig**: Orchestrierung kompiliert, Fehlerisolation implementiert.

## Etappe 6 — Weitere Adapter (parallel arbeitbar)

- [x] `googleWorkspace` + Test (3 Tests)
- [x] `metanetRss` + Test inkl. Wartungs-Filter (4 Tests)
- [x] `wedosStatusOnline` + Test inkl. Content-Type-Prüfung (3 Tests)
- [x] `githubIssues` + Test inkl. PR-Filter (4 Tests)

**Fertig**: Alle 5 Adapter implementiert und getestet. 36 Tests gesamt, alle grün.

## Etappe 7 — Infrastruktur

- [x] `infra/main.bicep` — Function App, Storage, App Insights, Action Group, Alert Rule
- [x] Bicep-Parameter für `webhookUrl`, `alertEmail`, `location`
- [ ] README-Abschnitt "Deployment" testen mit Dummy-Subscription

**Fertig wenn**: `az deployment group create` legt alle Ressourcen korrekt an. (Bicep geschrieben, Deployment steht aus)

## Etappe 8 — CI/CD

- [x] GitHub Actions: Build, Test, Lint bei jedem PR (`.github/workflows/ci.yml`)
- [x] GitHub Actions: Deploy (Function Code) bei Push auf `main` (`.github/workflows/deploy.yml`)
- [x] Azure OIDC Federation statt Service-Principal-Secret (Setup-Anleitung in `docs/DEPLOYMENT.md`)
- [x] `.funcignore` fuer schlanke Deployment-Pakete

## Etappe 9 — Erst-Deployment und Abnahme

- [ ] Deployment in Azure-Tenant
- [ ] Echten Webhook gegen einen Test-Chat-Raum konfigurieren
- [ ] Wartezeit / beobachten → erster realer Incident getriggert
- [ ] Alert-Rule manuell auslösen (Function deaktivieren) → Mail kommt an
- [ ] Abnahme mit Team

## Spätere Erweiterungen (bewusst nicht in V1)

- Update-Nachrichten zwischen `open` und `resolved` (z.B. "monitoring", "identified")
- Mehrere Chat-Ziele parallel (Fan-Out an mehrere Webhooks)
- Pro-Dienst-Routing (z.B. DevOps-Raum vs. Support-Raum)
- Geplante Wartungen als separate Nachrichten-Gattung
- Admin-UI zum Verwalten der Konfiguration
- Selbst überwachen per zweiter "canary"-Function (statt nur Azure Monitor)
- Slack-Notifier
- Deutsche Übersetzung der Titel (LLM-Aufruf)
- HTML-Scraping-Adapter für Status-Pages ohne API — **konkreter Anlass: Sophos** (`status.sophos.com`): läuft auf Atlassian Statuspage, aber alle JSON/RSS/Atom-Endpoints antworten mit HTTP 200 und liefern eine 404-HTML-Seite statt echter Daten. Ein realistischer Browser-User-Agent ändert daran nichts. Aktivierung erst, wenn entweder Sophos die API freischaltet oder dieser Adapter existiert. Eintrag in `config/providers.yaml` ist vorbereitet und auskommentiert.

## Bekannte Risiken / offene Recherche-Punkte

- **WEDOS Response-Format**: Dokumentation der JSON-Struktur muss bei Implementierung empirisch geprüft werden (kein offizielles Schema gefunden).
- **Metanet Status-Semantik**: Die Zuordnung "behoben" muss per RSS-Heuristik ermittelt werden; evtl. sind mehrere RSS-Einträge pro Incident nötig.
- **Kaseya Komponenten-Filter "IT Glue"**: Verfügbarkeit der Component-Namen in der Statuspage-API verifizieren.
- **GravityZone Cloud-Instanzen**: Die aktuellen Filter-Substrings (`cloudgz.gravityzone.bitdefender.com`, `cloud.gravityzone.bitdefender.com`) spiegeln die heutigen Instanz-URLs. Bei Rebranding oder Konsolidierung von Bitdefender (z.B. Migration auf andere Region) muss der `componentFilter` in `config/providers.yaml` nachgezogen werden, sonst verstummen Meldungen.
- **Claude Komponenten-Namen**: Anthropic benennt Produkte gelegentlich um (z.B. heisst die Konsole bereits offiziell „platform.claude.com (formerly console.anthropic.com)"). Vor Inbetriebnahme die aktuelle Component-Liste unter `https://status.claude.com/api/v2/components.json` abgleichen und ggf. die Substrings in `componentFilter` anpassen.
- **GitHub Rate Limit**: Ohne Token 60 Requests/h und Client-IP. Für Azure reicht das knapp. Mit Token 5'000/h.
