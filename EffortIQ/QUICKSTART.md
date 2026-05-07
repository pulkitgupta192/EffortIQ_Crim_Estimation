# EffortIQ Quick Start Guide

## 60-Second Setup

### 1. Install (1 minute)
```powershell
cd C:\Dev\EffortIQ
npm install
```

### 2. Configure AI (30 seconds)
```powershell
# Choose one provider and set the key:
$env:OPENAI_API_KEY = "sk-..."
# OR
$env:AZURE_OPENAI_KEY = "..."
# OR
$env:GEMINI_API_KEY = "..."
```

### 3. Run App (15 seconds)
```powershell
npm start
```

### 4. Setup in App (15 seconds)
- Click Settings
- Enter credentials
- Click "Save Configuration"

## Usage Workflow

```
┌─────────────────┐
│  Upload Excel   │  Prepare file with Summary, Description, CRIM Type
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Select Mode    │  Fetch-only or Create Tickets
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Process        │  AI analyzes and estimates each item
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Review Results │  View estimated hours and status
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Create Tickets │  Bulk create in Jira with estimates
└─────────────────┘
```

## Excel Template Structure

| Summary | Description | CRIM Type |
|---------|-------------|-----------|
| Create Customer Form | Build custom form with dropdown fields | Custom Page/Screen/Tab |
| SAP Integration | Bi-directional data sync | Interface (API) |
| Customer Migration | Migrate 10K records | Data Migration (Script) |

## Key Features

🎯 **One-Click Processing** - Upload → Estimate → Create Tickets

🤖 **Multiple AI Providers** - OpenAI, Azure, Gemini, Local

🔐 **Secure Storage** - Encrypted credentials in user home directory

📊 **Real-time Progress** - Live progress tracking and activity log

🎨 **Professional UI** - Modern dark theme with smooth animations

⚡ **Blazing Fast** - Native Electron app, no web overhead

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No config found" | Click Settings → Save Configuration |
| Excel not parsing | Check columns: Summary, Description, CRIM Type |
| Jira connection fails | Verify URL and API token |
| Timeout on API | Check internet, try smaller batch |
| Port in use | Close other Electron instances |

## Environment Variables

### OpenAI
```
OPENAI_API_KEY=sk-...
```

### Azure OpenAI
```
AZURE_OPENAI_ENDPOINT=https://resource.openai.azure.com
AZURE_OPENAI_KEY=key...
AZURE_OPENAI_DEPLOYMENT=gpt-35-turbo
AZURE_OPENAI_API_VERSION=2024-06-01
```

### Google Gemini
```
GEMINI_API_KEY=key...
```

### Local Service
```
LOCAL_ESTIMATE_ENDPOINT=http://localhost:8080/estimate
```

## Common CRIM Types & Effort Ranges

| Type | Effort |
|------|--------|
| Custom Objects | 0.25 - 4h |
| Custom Page/Screen | 1 - 16h |
| Interface (API) | 3 - 22h |
| Data Migration | 0.5 - 12h |
| Business Report | 1 - 15h |

## File Paths

- **App Config**: `~\.effortiq\config.json`
- **App Folder**: `c:\Dev\EffortIQ`
- **Source Code**: `src/` folder

## Building Installer

```powershell
# Create Windows installer
npm run build:win

# Output in dist/ folder
# Creates: EffortIQ Setup 1.0.0.exe (installer)
#          EffortIQ 1.0.0.exe (portable)
```

## Support

For issues or questions:
1. Check SETUP.md for detailed setup
2. Review README.md for full documentation
3. Check Activity Log in app for detailed messages
4. Verify environment variables are set correctly

---
**Ready? Start with `npm install` and `npm start`** 🚀
