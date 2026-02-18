---
summary: "Deploy OpenClaw to Azure Functions with Table Storage and Blob Storage"
read_when:
  - You want to deploy OpenClaw to Azure
  - You need a serverless, low-cost cloud deployment
  - You prefer Azure infrastructure
title: "Azure Functions"
---

# Azure Functions Deployment

Deploy OpenClaw as a serverless Azure Function with Azure Table Storage for memory persistence and Azure Blob Storage for session state. This is designed for **low-cost, pay-per-use** deployments using the Azure Functions Consumption Plan.

## Architecture

```
Telegram/WhatsApp ──▶ Azure Function (HTTP Trigger) ──▶ AI Provider (GitHub Copilot API)
                           │
                           ├── Azure Table Storage  (memory / embeddings)
                           ├── Azure Blob Storage   (session state)
                           └── Azure Key Vault      (secrets)
```

**Key Features:**
- **Stateless**: The function wakes only when a webhook arrives (no long-running gateway process)
- **Azure Table Storage**: Replaces local SQLite database for memory and embedding cache persistence
- **Azure Blob Storage**: Stores WhatsApp/Telegram session state across ephemeral function invocations
- **Azure Key Vault**: Securely stores sensitive credentials like GitHub tokens
- **Consumption Plan**: Pay only for execution time (first 1M requests/month are free)

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and configured
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Node.js 22+
- An Azure subscription

## Quick Start (Local Development)

Test the Azure Function locally before deploying:

```bash
# 1. Navigate to the azure-function directory
cd azure-function

# 2. Copy sample settings
cp local.settings.sample.json local.settings.json

# 3. Edit local.settings.json with your tokens
# Add TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, etc.

# 4. Install dependencies
npm install

# 5. Build and run locally
npm start
```

The function will start on `http://localhost:7071`. You can test webhooks locally using tools like ngrok.

## Deploy to Azure

### Option 1: One-Click Deployment with Bicep

The repository includes a Bicep template (`infra/main.bicep`) that provisions all required Azure resources:

```bash
# 1. Create a resource group
az group create --name rg-openclaw --location eastus

# 2. Deploy infrastructure (Function App + Storage + Key Vault)
az deployment group create \
  --resource-group rg-openclaw \
  --template-file infra/main.bicep \
  --parameters githubToken='<YOUR_GITHUB_TOKEN>'

# 3. Deploy the function code
cd azure-function
func azure functionapp publish func-openclaw-dev

# 4. Set the webhook URL
# For Telegram:
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://func-openclaw-dev.azurewebsites.net/api/telegram-webhook&secret_token=<SECRET>"
```

### Option 2: Manual Setup

If you prefer manual configuration:

<Steps>
  <Step title="Create a Storage Account">
    ```bash
    az storage account create \
      --name stoclawXXXXX \
      --resource-group rg-openclaw \
      --location eastus \
      --sku Standard_LRS
    ```
  </Step>

  <Step title="Create a Function App">
    ```bash
    az functionapp create \
      --resource-group rg-openclaw \
      --consumption-plan-location eastus \
      --runtime node \
      --runtime-version 22 \
      --functions-version 4 \
      --name func-openclaw-dev \
      --storage-account stoclawXXXXX
    ```
  </Step>

  <Step title="Configure App Settings">
    ```bash
    az functionapp config appsettings set \
      --name func-openclaw-dev \
      --resource-group rg-openclaw \
      --settings \
        TELEGRAM_BOT_TOKEN="<your-telegram-token>" \
        GITHUB_TOKEN="<your-github-token>" \
        OPENCLAW_AGENT_ID="default"
    ```
  </Step>

  <Step title="Deploy Function Code">
    ```bash
    cd azure-function
    func azure functionapp publish func-openclaw-dev
    ```
  </Step>
</Steps>

## Environment Variables

Configure these in your Function App settings:

| Variable                          | Description                         | Source                  |
| --------------------------------- | ----------------------------------- | ----------------------- |
| `TELEGRAM_BOT_TOKEN`              | Telegram Bot API token              | App Settings            |
| `TELEGRAM_WEBHOOK_SECRET`         | Secret for webhook validation       | App Settings            |
| `GITHUB_TOKEN`                    | GitHub Copilot API token            | Key Vault reference     |
| `AZURE_STORAGE_CONNECTION_STRING` | Storage account connection string   | Auto-set by Bicep       |
| `OPENCLAW_AGENT_ID`               | Agent identifier                    | App Settings (optional) |

### Using Key Vault for Secrets

The Bicep template automatically configures Key Vault integration. To add secrets manually:

```bash
# Store a secret in Key Vault
az keyvault secret set \
  --vault-name kv-openclaw-XXXXX \
  --name github-token \
  --value '<your-github-token>'

# Reference in Function App settings
az functionapp config appsettings set \
  --name func-openclaw-dev \
  --resource-group rg-openclaw \
  --settings GITHUB_TOKEN='@Microsoft.KeyVault(SecretUri=https://kv-openclaw-XXXXX.vault.azure.net/secrets/github-token/)'
```

## Project Structure

```
azure-function/
├── src/
│   ├── functions/
│   │   └── webhook.ts              # HTTP trigger entry point
│   └── storage/
│       └── session-store-azure.ts  # Azure Blob session persistence
├── host.json                       # Azure Functions host configuration
├── package.json
├── tsconfig.json
└── local.settings.sample.json      # Template for local development

infra/
└── main.bicep                      # Infrastructure as Code template
```

## Related Files

- **Infrastructure**: `/infra/main.bicep` — Complete Bicep template for Azure deployment
- **Memory Provider**: `/src/memory/memory-provider-azure.ts` — Azure Table Storage memory provider
- **Session Store**: `/azure-function/src/storage/session-store-azure.ts` — Azure Blob session storage
- **Function Handler**: `/azure-function/src/functions/webhook.ts` — HTTP trigger for webhooks

## Configuration Reference

The Azure Function uses the same configuration system as the standard OpenClaw gateway. See:

- [Gateway Configuration](/gateway/configuration)
- [Channel Configuration](/channels)
- [Memory Concepts](/concepts/memory)

## Monitoring and Debugging

Azure provides built-in monitoring through Application Insights:

```bash
# View logs
az monitor app-insights query \
  --app ai-openclaw-dev \
  --resource-group rg-openclaw \
  --analytics-query "traces | order by timestamp desc | limit 50"

# Stream live logs
func azure functionapp logstream func-openclaw-dev
```

## Cost Optimization

The Consumption Plan offers excellent cost efficiency:

- **Free tier**: 1M requests and 400,000 GB-s execution time per month
- **Storage costs**: Minimal for Table Storage and Blob Storage (typically < $1/month)
- **Key Vault**: $0.03 per 10,000 operations (secrets retrieval)

For typical personal use (a few hundred messages per day), monthly costs are usually under $5.

## Limitations

- **Cold starts**: First request after idle period may take 5-10 seconds
- **Execution timeout**: 5 minutes on Consumption Plan (10 minutes on Premium)
- **Vector search**: Not included; use keyword search or integrate Azure AI Search
- **Long-running tasks**: Not suitable for multi-minute operations

For always-on deployments with faster response times, consider:
- [Azure Container Apps](/install/azure-container-apps) (planned)
- [VM-based deployments](/install/gcp) (GCP, Hetzner, etc.)

## Troubleshooting

<AccordionGroup>
  <Accordion title="Function not receiving webhooks">
    1. Verify the webhook URL is correctly set in Telegram/WhatsApp
    2. Check that the function app is running: `az functionapp show --name func-openclaw-dev --resource-group rg-openclaw`
    3. Ensure firewall rules allow inbound HTTPS traffic
    4. Check Application Insights for error logs
  </Accordion>

  <Accordion title="Authentication errors with Key Vault">
    The Function App needs proper permissions to access Key Vault:

    ```bash
    # Verify managed identity is enabled
    az functionapp identity show --name func-openclaw-dev --resource-group rg-openclaw

    # Grant Secret User role
    az role assignment create \
      --role "Key Vault Secrets User" \
      --assignee <managed-identity-principal-id> \
      --scope /subscriptions/<sub-id>/resourceGroups/rg-openclaw/providers/Microsoft.KeyVault/vaults/kv-openclaw-XXXXX
    ```
  </Accordion>

  <Accordion title="Storage connection issues">
    Verify the storage connection string:

    ```bash
    az functionapp config appsettings list \
      --name func-openclaw-dev \
      --resource-group rg-openclaw \
      | grep AZURE_STORAGE_CONNECTION_STRING
    ```
  </Accordion>
</AccordionGroup>

## Next Steps

- Configure your messaging channels: [Channels](/channels)
- Set up webhooks: [Webhook automation](/automation/webhook)
- Monitor usage: [Usage tracking](/concepts/usage-tracking)
- Secure your deployment: [Gateway authentication](/gateway/authentication)

## Additional Resources

- [Azure Functions documentation](https://learn.microsoft.com/azure/azure-functions/)
- [Azure Table Storage overview](https://learn.microsoft.com/azure/storage/tables/)
- [Azure Bicep documentation](https://learn.microsoft.com/azure/azure-resource-manager/bicep/)
