// ============================================================================
// status-page-to-chat — Azure-Infrastruktur
// ============================================================================
// Ressourcen: Storage Account, Application Insights, Function App,
//             Action Group, Alert Rule (Self-Monitoring)
//
// Deployment:
//   az deployment group create \
//     --resource-group rg-status-page-to-chat \
//     --template-file infra/main.bicep \
//     --parameters webhookUrl='<URL>' alertEmail='<EMAIL>'
// ============================================================================

@description('Webhook-URL fuer Google Chat oder Microsoft Teams')
@secure()
param webhookUrl string

@description('E-Mail-Adresse fuer Self-Monitoring-Alarme')
param alertEmail string

@description('Azure-Region')
param location string = resourceGroup().location

@description('Projekt-Praefix fuer Ressourcen-Namen')
param prefix string = 'spagetochat'

// --- Storage Account ---
var storageAccountName = '${prefix}${uniqueString(resourceGroup().id)}'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(storageAccountName, 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// --- Log Analytics Workspace (Voraussetzung fuer workspace-basiertes App Insights) ---
resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'law-status-page-to-chat'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// --- Application Insights ---
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-status-page-to-chat'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    RetentionInDays: 30
    WorkspaceResourceId: logAnalyticsWorkspace.id
  }
}

// --- App Service Plan (Consumption) ---
resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-status-page-to-chat'
  location: location
  kind: 'linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

// --- Function App ---
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-status-page-to-chat'
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'WEBHOOK_URL', value: webhookUrl }
      ]
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
    }
  }
}

// --- Action Group (E-Mail-Benachrichtigung) ---
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-status-page-to-chat'
  location: 'global'
  properties: {
    groupShortName: 'sp2c-alert'
    enabled: true
    emailReceivers: [
      {
        name: 'ops-email'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// --- Alert Rule: Function Execution Count < 1 in 15 min ---
resource alertRule 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-no-executions'
  location: 'global'
  properties: {
    description: 'Alarm wenn die Function in den letzten 15 Minuten nicht ausgefuehrt wurde'
    severity: 2
    enabled: true
    scopes: [ functionApp.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'NoExecutions'
          metricName: 'FunctionExecutionCount'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
  }
}

// --- Outputs ---
output functionAppName string = functionApp.name
output storageAccountName string = storageAccount.name
output appInsightsName string = appInsights.name
