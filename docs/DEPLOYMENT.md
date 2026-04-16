# Deployment

> ⚠️ **Review recommended** — this document describes Azure infrastructure. Before first deployment to the production subscription, have a second person verify the values.

## Target state

| Resource | Type | Purpose |
|---|---|---|
| Resource Group `rg-status-page-to-chat` | | Container for all resources |
| Storage Account `stspagetochat...` | Standard_LRS | Function runtime + `incidents` table |
| Application Insights `appi-status-page-to-chat` | | Logs, metrics, traces |
| Function App `func-status-page-to-chat` | Linux, Consumption Plan, Node 20 | Hosts the Timer Trigger |
| Action Group `ag-status-page-to-chat` | | Email recipient for alerts |
| Alert Rule | Metric Alert | "FunctionExecutionCount < 1 in 15 min" |

Defined in **`infra/main.bicep`**.

## Prerequisites (operator)

- Azure CLI installed and logged in: `az login`
- Access to the correct subscription: `az account set --subscription <name>`
- Sufficient roles: `Contributor` on subscription or resource group
- Webhook URL for Google Chat or Teams prepared
- Email address for alerts (group mail recommended)

## First deployment

### 1. Create resource group

```bash
az group create \
  --name rg-status-page-to-chat \
  --location switzerlandnorth
```

### 2. Deploy infrastructure

```bash
az deployment group create \
  --resource-group rg-status-page-to-chat \
  --template-file infra/main.bicep \
  --parameters \
      webhookUrl='<GOOGLE_CHAT_OR_TEAMS_WEBHOOK>' \
      alertEmail='<ops@raptus.ch>'
```

### 3. Deploy Function code

```bash
pnpm build
func azure functionapp publish func-status-page-to-chat
```

### 4. Verify configuration

- Portal: Function App → Functions → `poll` → invocations → first run visible?
- Test: a known open incident should trigger a chat message on the next timer run.

## Ongoing deployment (updates)

- Changes to **`config/providers.yaml`**: delivered with the next `func azure functionapp publish`.
- Changes to adapter code: same publish process.
- Infrastructure changes: run `az deployment group create` again.

The GitHub Actions workflow `.github/workflows/deploy.yml` deploys automatically on push to `main`. CI (Build + Lint + Test) also runs on every pull request via `.github/workflows/ci.yml`.

## GitHub Actions Setup (one-time)

The deployment uses **Azure OIDC Federation** instead of Service Principal secrets. Once set up — no rotating credentials.

### 1. Create App Registration with Federated Credential

```bash
# Adjust variables
APP_NAME="github-actions-status-page-to-chat"
GITHUB_ORG="raptus"
GITHUB_REPO="status-page-to-chat"
RESOURCE_GROUP="rg-status-page-to-chat"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Create App Registration
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Federated Credential for main branch (deploy workflow)
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters "{
    \"name\": \"main-branch\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/main\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

# Federated Credential for environment "production" (recommended)
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters "{
    \"name\": \"production-env\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${GITHUB_ORG}/${GITHUB_REPO}:environment:production\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

# Assign role on resource group
az role assignment create \
  --role "Contributor" \
  --assignee "$APP_ID" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"

# Output values for GitHub Secrets
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$TENANT_ID"
echo "AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID"
```

### 2. Set GitHub Secrets

In the repo under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | App ID from step 1 |
| `AZURE_TENANT_ID` | Tenant ID from step 1 |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID from step 1 |

### 3. Create GitHub Environment "production" (optional, recommended)

Under **Settings → Environments → New environment**: `production`. Optionally define Protection Rules (Approvals, Wait Timer) so deployments are reviewed.

## Secrets

Secrets are stored as **Application Settings** on the Function App — never in the repo.

| Setting | Source |
|---|---|
| `WEBHOOK_URL` | Set via Bicep parameter |
| `ALERT_EMAIL` | Set via Bicep parameter (Action Group) |
| `AzureWebJobsStorage` | Automatically set by Bicep |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Automatically set by Bicep |
| `GITHUB_TOKEN` (optional) | Set afterwards if needed: `az functionapp config appsettings set` |

Rotating the webhook URL:

```bash
az functionapp config appsettings set \
  --name func-status-page-to-chat \
  --resource-group rg-status-page-to-chat \
  --settings WEBHOOK_URL='<new-webhook>'
```

## Rollback

- Deployments are **immutable packages**. Rollback = redeploy an older package.
- Configuration rollback: `git revert` on `providers.yaml` and republish.

## Monitoring queries (App Insights)

**Has the timer fired in the last 15 minutes?**

```kusto
traces
| where cloud_RoleName == "func-status-page-to-chat"
| where message startswith "run_summary"
| where timestamp > ago(15m)
| count
```

**Errors per adapter (24 h)**:

```kusto
traces
| where cloud_RoleName == "func-status-page-to-chat"
| where severityLevel >= 3
| where timestamp > ago(24h)
| summarize count() by tostring(customDimensions.providerKey)
```

## Running locally

See also "Local development" section in [AGENTS.md](AGENTS.md).

1. Create `local.settings.json` (from `local.settings.json.example`):

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "WEBHOOK_URL": "https://webhook.site/<your-test-slot>"
  }
}
```

2. Start Azurite (local Azure Storage emulator): `azurite --silent`
3. `pnpm install && pnpm build && func start`
4. Monitor the test webhook target via [webhook.site](https://webhook.site).

## Cost control

- Set up a **Budget Alert**: Portal → Cost Management → Budget for `rg-status-page-to-chat`, threshold CHF 2/month, email to ops.
- Set App Insights **Daily Cap** to e.g. 100 MB to prevent a logging runaway from inflating the bill.
