# Deployment

> ⚠️ **Review empfohlen** — dieses Dokument beschreibt Azure-Infrastruktur. Vor erstmaligem Deployment ins produktive Subscription-Konto lässt eine zweite Person die Werte gegenprüfen.

## Zielbild

| Ressource | Typ | Zweck |
|---|---|---|
| Resource Group `rg-status-page-to-chat` | | Container aller Ressourcen |
| Storage Account `stspagetochat...` | Standard_LRS | Function Runtime + `incidents`-Table |
| Application Insights `appi-status-page-to-chat` | | Logs, Metrics, Traces |
| Function App `func-status-page-to-chat` | Linux, Consumption Plan, Node 20 | Hostet den Timer Trigger |
| Action Group `ag-status-page-to-chat` | | E-Mail-Empfänger für Alarme |
| Alert Rule | Metric Alert | "FunctionExecutionCount < 1 in 15 min" |

Definiert in **`infra/main.bicep`** (wird im Implementierungsschritt erstellt).

## Voraussetzungen (Betreiber)

- Azure CLI installiert und eingeloggt: `az login`
- Zugriff auf das richtige Subscription: `az account set --subscription <name>`
- Ausreichende Rollen: `Contributor` auf Subscription oder Resource Group
- Webhook-URL für Google Chat oder Teams vorbereitet
- E-Mail-Adresse für Alarme (Gruppen-Mail empfohlen)

## Erst-Deployment

### 1. Resource Group anlegen

```bash
az group create \
  --name rg-status-page-to-chat \
  --location switzerlandnorth
```

### 2. Infrastruktur deployen

```bash
az deployment group create \
  --resource-group rg-status-page-to-chat \
  --template-file infra/main.bicep \
  --parameters \
      webhookUrl='<GOOGLE_CHAT_ODER_TEAMS_WEBHOOK>' \
      alertEmail='<ops-empfänger@raptus.ch>'
```

### 3. Function Code deployen

```bash
pnpm build
cd dist   # oder wo das Build-Output liegt
func azure functionapp publish func-status-page-to-chat
```

### 4. Konfiguration prüfen

- Portal: Function App → Functions → `poll` → invocations → erster Lauf sichtbar?
- Testweise: ein bekannter offener Incident sollte beim nächsten Timer eine Chat-Nachricht erzeugen.

## Laufendes Deployment (Updates)

- Änderungen an **`config/providers.yaml`**: werden beim nächsten `func azure functionapp publish` mit ausgeliefert.
- Änderungen am Adapter-Code: gleicher Publish-Prozess.
- Infrastruktur-Änderungen: erneut `az deployment group create`.

Empfehlung: GitHub Actions Workflow für Build + Deploy (wird in der Roadmap umgesetzt).

## Secrets

Secrets werden als **Application Settings** auf der Function App gespeichert — nie im Repo.

| Setting | Quelle |
|---|---|
| `WEBHOOK_URL` | Wird via Bicep-Parameter gesetzt |
| `ALERT_EMAIL` | Wird via Bicep-Parameter gesetzt (Action Group) |
| `AzureWebJobsStorage` | Automatisch durch Bicep |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Automatisch durch Bicep |
| `GITHUB_TOKEN` (optional) | Bei Bedarf nachträglich setzen: `az functionapp config appsettings set` |

Webhook-URL rotieren:

```bash
az functionapp config appsettings set \
  --name func-status-page-to-chat \
  --resource-group rg-status-page-to-chat \
  --settings WEBHOOK_URL='<neuer-webhook>'
```

## Rollback

- Deployments sind **immutable Pakete**. Rollback = älteres Paket erneut deployen.
- Configuration-Rollback: `providers.yaml` per Git-Revert und erneut publishen.

## Monitoring-Abfragen (App Insights)

**Hat der Timer in den letzten 15 Minuten gefeuert?**

```kusto
traces
| where cloud_RoleName == "func-status-page-to-chat"
| where message startswith "run_summary"
| where timestamp > ago(15m)
| count
```

**Fehler pro Adapter (24 h)**:

```kusto
traces
| where cloud_RoleName == "func-status-page-to-chat"
| where severityLevel >= 3
| where timestamp > ago(24h)
| summarize count() by tostring(customDimensions.providerKey)
```

## Lokales Ausführen

Siehe auch Abschnitt "Lokale Entwicklung" in [AGENTS.md](AGENTS.md).

1. `local.settings.json` anlegen (aus `local.settings.json.example`):

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "WEBHOOK_URL": "https://webhook.site/<dein-test-slot>"
  }
}
```

2. Azurite starten (lokaler Azure-Storage-Emulator): `azurite --silent`
3. `pnpm install && pnpm build && func start`
4. Test-Webhook-Ziel über [webhook.site](https://webhook.site) beobachten.

## Kostenkontrolle

- **Budget Alert** einrichten: Portal → Cost Management → Budget für `rg-status-page-to-chat`, Schwelle 2 CHF/Monat, Mail an Ops.
- App Insights **Daily Cap** auf z.B. 100 MB setzen, damit ein Log-Amoklauf nicht die Rechnung explodieren lässt.
