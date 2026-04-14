# Adapter

Jeder Adapter implementiert das Interface:

```ts
interface StatusProvider {
  readonly key: string;
  readonly displayName: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
}
```

Die Aufgabe jedes Adapters: Rohdaten holen, offene + kürzlich geschlossene Incidents extrahieren, ins [`NormalizedIncident`-Format](ARCHITECTURE.md#normalizedincident) mappen.

---

## 1. `atlassian-statuspage`

**Abgedeckte Dienste**: Bitbucket, Bitwarden, Bexio, Webflow, DigiCert, NinjaOne, Sucuri, SmartRecruiters, Retool, Zendesk, Langdock, Kaseya — alles was auf Atlassian Statuspage läuft.

### Endpunkte

- Offene Incidents: `{baseUrl}/api/v2/incidents/unresolved.json`
- Letzte Incidents (inkl. kürzlich resolved): `{baseUrl}/api/v2/incidents.json`
- Summary (optional, für Komponenten-Lookup): `{baseUrl}/api/v2/summary.json`

### Mapping

| Statuspage-Feld | Normalized-Feld |
|---|---|
| `id` | `externalId` |
| `name` | `title` |
| `status` | `status` (mapping siehe unten) |
| `shortlink` oder `{baseUrl}/incidents/{id}` | `url` |
| `created_at` | `startedAt` |
| `updated_at` | `updatedAt` |

**Status-Mapping**:

- `resolved`, `completed`, `postmortem` → `resolved`
- alles andere (`investigating`, `identified`, `monitoring`, …) → `open`

### Komponenten-Filter

Optional (`componentFilter: "raptus-helpcenter"`): Ein Incident wird nur übernommen, wenn mindestens eine verknüpfte Component diesen Namen enthält (case-insensitive substring match).

### Konfiguration

```yaml
- key: bexio
  displayName: Bexio
  adapter: atlassian-statuspage
  baseUrl: https://www.bexio-status.com
```

---

## 2. `google-workspace`

**Dienst**: Google Workspace Status Dashboard.

### Endpunkt

- `https://www.google.com/appsstatus/dashboard/incidents.json`

### Mapping

Die JSON-Struktur enthält eine Liste aktiver und historischer Incidents mit:

| Google-Feld | Normalized-Feld |
|---|---|
| `id` | `externalId` |
| `external_desc` | `title` |
| `begin` | `startedAt` |
| `modified` | `updatedAt` |
| `end` (vorhanden?) | Bestimmt `status`: vorhanden = `resolved`, sonst `open` |
| `uri` (Details) bzw. Dashboard-URL | `url` |

### Konfiguration

```yaml
- key: google-workspace
  displayName: Google Workspace
  adapter: google-workspace
```

---

## 3. `metanet-rss`

**Dienst**: Metanet Switzerland Status-Meldungen.

### Endpunkt

- `https://support.metanet.ch/xml/statusmeldungen.xml` (RSS)

### Mapping

RSS Items enthalten Titel, Link, pubDate, description. Zusätzlich Kategorisierung im Titel/Body ("Betriebsunterbruch", "Wartungsarbeiten", "Technische Infos").

| RSS-Feld | Normalized-Feld |
|---|---|
| `guid` oder `link` | `externalId` |
| `title` | `title` |
| `pubDate` | `startedAt` / `updatedAt` |
| `link` | `url` |
| Kategorie / Body-Keywords | Bestimmt `status` |

**Status-Heuristik**:

- Enthält Titel/Body Stichworte wie "behoben", "gelöst", "ended" → `resolved`
- Typ "Wartungsarbeiten" → wird übersprungen (laut Plan: keine Maintenance-Meldungen)
- Sonst → `open`

### Konfiguration

```yaml
- key: metanet
  displayName: Metanet
  adapter: metanet-rss
```

---

## 4. `wedos-status-online`

**Dienst**: WEDOS (wedos.status.online Plattform).

### Endpunkt

- `https://wedos.status.online/en/json/incidents.json`

### Mapping

Die JSON-API liefert Incidents mit eigenem Schema (noch in Implementierung zu verifizieren). Erwartete Felder:

| WEDOS-Feld | Normalized-Feld |
|---|---|
| `id` | `externalId` |
| `name` / `title` | `title` |
| `status` / `resolved_at` | `status` |
| Start/Update-Timestamps | `startedAt` / `updatedAt` |
| Link zur Incident-Seite | `url` |

### Konfiguration

```yaml
- key: wedos
  displayName: WEDOS
  adapter: wedos-status-online
```

---

## 5. `github-issues`

**Dienst**: Projekte, die GitHub Issues als Status-Tracker nutzen (z.B. Onetime Secret).

### Endpunkt

- GitHub REST API: `GET https://api.github.com/repos/{owner}/{repo}/issues?state=all&per_page=30`

Tipp: Authentisierung optional (höheres Rate-Limit). Wenn ein Token gesetzt wird, erfolgt dies per App Setting `GITHUB_TOKEN`.

### Mapping

| GitHub-Feld | Normalized-Feld |
|---|---|
| `id` bzw. `number` | `externalId` |
| `title` | `title` |
| `state` (`open`/`closed`) | `status` (`open` → `open`, `closed` → `resolved`) |
| `created_at` | `startedAt` |
| `updated_at` | `updatedAt` |
| `html_url` | `url` |

### Konfiguration

```yaml
- key: onetimesecret
  displayName: Onetime Secret
  adapter: github-issues
  owner: onetimesecret
  repo: status
```

---

## Neuen Adapter hinzufügen

1. Neue Datei unter `src/adapters/<name>.ts` anlegen. Implementierung muss `StatusProvider` erfüllen.
2. In `src/adapters/index.ts` registrieren.
3. zod-Schema für adapter-spezifische Config-Felder in `src/lib/config.ts` ergänzen.
4. Unit-Test unter `tests/adapters/<name>.test.ts` mit mindestens einem Fixture (realer gespeicherter Response).
5. Dokumentations-Abschnitt in diesem File ergänzen.
