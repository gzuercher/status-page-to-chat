# Roadmap

Die Umsetzung des Dienstes erfolgt in aufeinander aufbauenden Etappen. Jede Etappe ist so geschnitten, dass sie **einzeln reviewbar und lauffähig** ist.

Legende: `[ ]` offen · `[~]` in Arbeit · `[x]` erledigt

## Etappe 1 — Grundgerüst

- [ ] `package.json` mit Dependencies: `@azure/functions`, `@azure/data-tables`, `zod`, `yaml`, `pino`, `undici`
- [ ] Dev-Deps: `typescript`, `vitest`, `eslint`, `prettier`, `@types/node`
- [ ] `tsconfig.json` (strict, target ES2022)
- [ ] `host.json` (Functions v4)
- [ ] `local.settings.json.example`
- [ ] `.eslintrc`, `.prettierrc`
- [ ] Scripts: `build`, `test`, `lint`, `format`
- [ ] `src/lib/types.ts` mit `NormalizedIncident`, `StatusProvider`, `Notifier`
- [ ] `src/lib/logger.ts` (pino)

**Fertig wenn**: `pnpm install && pnpm build` läuft durch.

## Etappe 2 — Config & State

- [ ] `src/lib/config.ts`: YAML laden, zod-Schema, Umgebungsvariablen lesen
- [x] `config/providers.yaml` mit Starter-Einträgen (vorgezogen; enthält aktuell 19 Provider inkl. Atlassian-, Google-Workspace-, Metanet-, WEDOS- und GitHub-Issues-Einträge)
- [ ] `src/state/tableStore.ts`: CRUD auf Azure Table Storage, Abgleich-Logik
- [ ] Unit-Tests für config-Validierung und State-Diff

**Fertig wenn**: Tests grün, State-Diff erkennt korrekt Neu/Behoben/Unverändert.

## Etappe 3 — Erster Adapter (Atlassian)

- [ ] `src/adapters/atlassianStatuspage.ts`
- [ ] `tests/adapters/atlassianStatuspage.test.ts` mit Fixture für offene + geschlossene Incidents
- [ ] Komponenten-Filter-Logik: unterstützt sowohl `string` als auch `string[]` (OR-Logik). Tests für beide Formen + für „kein Filter"-Fall.
- [ ] zod-Schema: `componentFilter: z.union([z.string(), z.array(z.string())]).optional()`
- [ ] Status-Mapping-Test
- [ ] Response-Validierung: Content-Type prüfen und JSON parsen in try/catch — HTTP 200 ist **kein** Beweis, dass der Body JSON ist (Atlassian-Pages können bei deaktivierter API eine 404-HTML-Seite mit Status 200 zurückliefern, siehe Sophos).

**Fertig wenn**: Adapter gibt aus einer echten Statuspage-Response korrekt normalisierte Incidents zurück.

## Etappe 4 — Notifier

- [ ] `src/notifiers/googleChat.ts` (Card v2)
- [ ] `src/notifiers/teams.ts` (Adaptive Card)
- [ ] Gemeinsames Interface in `src/notifiers/index.ts`
- [ ] Tests mit Mock-Fetch, Payload-Struktur verifizieren
- [ ] Retry-Logik (1x Backoff) mit Test

**Fertig wenn**: Manueller Testlauf mit webhook.site zeigt korrekt formatierte Nachrichten.

## Etappe 5 — Orchestrierung

- [ ] `src/functions/poll.ts` Timer Trigger
- [ ] Fehlerisolation pro Provider (fehlgeschlagene Adapter blockieren andere nicht)
- [ ] Strukturiertes `run_summary`-Log je Durchlauf
- [ ] Integrationstest mit gemockten Adaptern + In-Memory-State

**Fertig wenn**: Lokaler Lauf verarbeitet mehrere Provider parallel, Fehler in einem Adapter bricht nicht ab.

## Etappe 6 — Weitere Adapter (parallel arbeitbar)

- [ ] `googleWorkspace` + Test
- [ ] `metanetRss` + Test (inkl. Wartungs-Filter)
- [ ] `wedosStatusOnline` + Test (inkl. Verifikation der echten Response-Struktur)
- [ ] `githubIssues` + Test

## Etappe 7 — Infrastruktur

- [ ] `infra/main.bicep` — Function App, Storage, App Insights, Action Group, Alert Rule
- [ ] Bicep-Parameter für `webhookUrl`, `alertEmail`, `location`
- [ ] README-Abschnitt "Deployment" testen mit Dummy-Subscription

**Fertig wenn**: `az deployment group create` legt alle Ressourcen korrekt an.

## Etappe 8 — CI/CD

- [ ] GitHub Actions: Build, Test, Lint bei jedem PR
- [ ] GitHub Actions: Deploy (Function Code) bei Push auf `main`
- [ ] Azure OIDC Federation statt Service-Principal-Secret

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
