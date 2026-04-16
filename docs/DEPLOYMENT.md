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

Der GitHub Actions Workflow `.github/workflows/deploy.yml` deployt automatisch bei Push auf `main`. CI (Build + Lint + Test) läuft zusätzlich bei jedem Pull Request via `.github/workflows/ci.yml`.

## GitHub Actions Setup (einmalig)

Das Deployment nutzt **Azure OIDC Federation** statt Service-Principal-Secrets. Einmal eingerichtet — keine rotierenden Secrets.

### 1. App Registration mit Federated Credential anlegen

```bash
# Variablen anpassen
APP_NAME="github-actions-status-page-to-chat"
GITHUB_ORG="raptus"
GITHUB_REPO="status-page-to-chat"
RESOURCE_GROUP="rg-status-page-to-chat"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# App Registration erstellen
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Federated Credential fuer main-Branch (Deploy-Workflow)
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters "{
    \"name\": \"main-branch\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/main\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

# Federated Credential fuer Environment "production" (empfohlen)
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters "{
    \"name\": \"production-env\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${GITHUB_ORG}/${GITHUB_REPO}:environment:production\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

# Rolle auf Resource Group zuweisen
az role assignment create \
  --role "Contributor" \
  --assignee "$APP_ID" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"

# Werte fuer GitHub Secrets ausgeben
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$TENANT_ID"
echo "AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID"
```

### 2. GitHub Secrets setzen

Im Repo unter **Settings → Secrets and variables → Actions**:

| Secret | Wert |
|---|---|
| `AZURE_CLIENT_ID` | App-ID aus Schritt 1 |
| `AZURE_TENANT_ID` | Tenant-ID aus Schritt 1 |
| `AZURE_SUBSCRIPTION_ID` | Subscription-ID aus Schritt 1 |

### 3. GitHub Environment "production" anlegen (optional, empfohlen)

Unter **Settings → Environments → New environment**: `production`. Optional Protection Rules (Approvals, Wait Timer) definieren, damit Deployments reviewt werden.

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
