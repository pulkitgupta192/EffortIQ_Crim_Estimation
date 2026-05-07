# EffortIQ - Windows Desktop Application

**Intelligent Effort Estimation for Jira** 

EffortIQ is a professional, lightweight Windows desktop application for bulk effort estimation and Jira ticket creation using AI providers (OpenAI, Azure OpenAI, Google Gemini, or local services).

## 🚀 Features

### Core Functionality
- ✅ **Excel Upload** - Load CRIM data (Summary, Description, CRIM Type) from Excel files
- ✅ **AI-Powered Estimation** - Get intelligent effort estimates using your preferred AI provider
- ✅ **Bulk Jira Integration** - Create multiple Jira tickets in one click
- ✅ **Flexible Modes** - Fetch-only mode for estimates without ticket creation
- ✅ **Multiple AI Providers** - Support for:
  - OpenAI (GPT-4o-mini)
  - Azure OpenAI
  - Google Gemini
  - Local/On-premises Services

### UI/UX
- 💎 **Professional Design** - Modern dark theme with smooth animations
- 📊 **Real-time Progress** - Live progress tracking during processing
- 🎯 **Intuitive Navigation** - Easy-to-use sidebar with clear sections
- 🔔 **Toast Notifications** - Instant feedback on all operations
- 📋 **Activity Log** - Track all operations with timestamps

### Configuration
- ⚙️ **Secure Credentials** - Encrypted storage of API keys and tokens
- 🔗 **Jira Connection** - Connection testing before bulk operations
- 🛡️ **Environment Variables** - Support for system environment variables

## 📋 Project Structure

```
EffortIQ/
├── src/
│   ├── main/
│   │   ├── index.js           # Main process & IPC handlers
│   │   └── preload.js         # Preload script (context isolation)
│   ├── renderer/
│   │   ├── index.html         # Main UI
│   │   ├── styles.css         # Professional styling
│   │   └── renderer.js        # UI logic & event handlers
│   ├── services/
│   │   ├── excelService.js    # Excel parsing
│   │   ├── jiraService.js     # Jira REST API integration
│   │   ├── configService.js   # Configuration management
│   │   └── estimationEngine.js # Estimation orchestration
│   └── providers/
│       ├── openaiProvider.js  # OpenAI implementation
│       ├── azureProvider.js   # Azure OpenAI implementation
│       ├── geminiProvider.js  # Google Gemini implementation
│       └── localProvider.js   # Local service implementation
├── assets/                    # App icons & resources
├── package.json              # Dependencies & build config
└── README.md                 # This file
```

## 🔧 Setup & Installation

### Prerequisites
- Node.js 16+ 
- npm or yarn
- Windows 7+ for the desktop app

### Installation Steps

1. **Install Dependencies**
   ```bash
   cd c:\Dev\EffortIQ
   npm install
   ```

2. **Configure Environment Variables** (in PowerShell or Command Prompt)
   ```powershell
   # For OpenAI
   $env:OPENAI_API_KEY = "sk-..."

   # For Azure OpenAI
   $env:AZURE_OPENAI_ENDPOINT = "https://<resource>.openai.azure.com"
   $env:AZURE_OPENAI_KEY = "your-key"
   $env:AZURE_OPENAI_DEPLOYMENT = "deployment-name"
   $env:AZURE_OPENAI_API_VERSION = "2024-06-01"

   # For Gemini
   $env:GEMINI_API_KEY = "your-key"

   # For Local Service
   $env:LOCAL_ESTIMATE_ENDPOINT = "http://localhost:8080/estimate"
   ```

### Running the Application

**Development Mode** (with DevTools)
```bash
npm run dev
```

**Production Mode**
```bash
npm start
```

### Building Windows Installer

**Create NSIS Installer**
```bash
npm run build:win
```

**Create Portable Executable**
```bash
npm run pack
```

## 📱 Usage Guide

### 1. Initial Setup
- Open EffortIQ
- Navigate to **Settings** section
- Select your preferred AI provider (OpenAI, Azure, Gemini, or Local)
- Enter API credentials
- Configure Jira connection details
- Click "Test Connection" to verify
- Save configuration

### 2. Upload Excel File
- Go to **Upload** section
- Click "Upload Excel File" or drag-drop your file
- Select file with columns: **Summary**, **Description**, **CRIM Type**
- Preview data to verify correct parsing

### 3. Process Estimates
- Choose AI Provider from dropdown
- Select processing mode:
  - **Fetch Estimates Only** - Get effort estimates without creating tickets
  - **Create Jira Tickets** - Generate both estimates and Jira tickets
- Click "Process & Generate Estimates"
- Monitor progress in real-time

### 4. Review Results
- View estimation results in the results table
- Each row shows Summary, CRIM Type, Estimated Hours, and Status
- If errors occur, view the reason in the Status column

### 5. Upload to Jira (Optional)
- If "Create Jira Tickets" was selected, click "Upload to Jira"
- Tickets are created in the specified project
- Estimates are stored in the "Original Estimate" field
- Custom field "C_CRIM_TYPE" is populated with the CRIM type

## 🔐 Security Considerations

- **API Keys**: Stored encrypted locally in `~\.effortiq\config.json`
- **Jira Token**: Base64 encoded (use for production)
- **Context Isolation**: Renderer process cannot access Node.js APIs directly
- **No Network Bypass**: All external API calls go through main process

## 📊 CRIM Type Reference

Supported CRIM Types (automatically mapped to effort ranges):

| CRIM Type | Code | Effort Range |
|-----------|------|--------------|
| Custom Objects | CU_OB | 0.25 - 4 hours |
| Custom Page/Screen | CU_PA | 1 - 16 hours |
| Custom Event | CU_EV | 1 - 14 hours |
| BPA | CU_BP | 1 - 18 hours |
| Lobby | CU_LO | 0.75 - 9 hours |
| Business Report | RE_BR | 1 - 15 hours |
| Quick Report | RE_QR | 0.5 - 6 hours |
| Interface (IN) | IN_IN | 4 - 30 hours |
| Interface (OUT) | IN_OU | 3 - 22 hours |
| Interface (API) | IN_AP | 3 - 22 hours |
| Data Migration | DM_MT/DM_SC | 0.5 - 12 hours |

## 🛠️ Troubleshooting

### "Configuration not found" Error
- Ensure you've clicked "Save Configuration" in Settings
- Config is stored in `%USERPROFILE%\.effortiq\config.json`

### Excel file not parsing
- Verify columns are named: Summary, Description, CRIM Type
- Ensure file is .xlsx or .xls format
- Check for special characters or encoding issues

### Jira connection fails
- Verify Jira URL is correct (e.g., https://yourjira.atlassian.net)
- Confirm API token is valid (not expired)
- Check firewall/proxy settings

### AI estimation times out
- Check internet connection
- Verify API key is valid
- Try with smaller batch (10-20 items first)
- Check API rate limits

## 📝 Excel File Format

Your Excel file should have three columns:

| Summary | Description | CRIM Type |
|---------|-------------|-----------|
| Create custom form for AP | Form to capture accounts payable data | Custom Page/Screen/Tab |
| Build interface to SAP | Bi-directional interface | Interface (API) |
| Migrate customer master | Data migration from legacy system | Data Migration (Script) |

## 🔄 Workflow Example

1. **Export CRIM List** from Jira or Excel
2. **Upload File** using EffortIQ
3. **Configure AI Provider** (Azure recommended for enterprise)
4. **Process & Review** - AI analyzes each item
5. **Create Jira Tickets** - Bulk create with effort estimates
6. **Plan Sprint** - Use estimates for sprint planning

## 📦 Dependencies

- **electron** - Desktop application framework
- **axios** - HTTP client for API calls
- **xlsx** - Excel file parsing
- **dotenv** - Environment variable management
- **js-yaml** - YAML configuration parsing

## 🤝 Integration with Existing System

EffortIQ reuses the same:
- AI provider logic from your Jira Forge plugin
- CRIM type mappings and effort ranges
- Jira REST API endpoints
- Configuration file structure

**Seamless migration path**: Extract your existing AI provider implementations and they work directly in EffortIQ!

## 📄 License

Internal Use Only

## 🎯 Future Enhancements

- [ ] Batch processing with queuing
- [ ] Integration with Azure DevOps
- [ ] Historical comparison and analytics
- [ ] Custom CRIM type definitions
- [ ] Import/Export of results to CSV
- [ ] Real-time collaboration with team
- [ ] Scheduled batch processing
- [ ] AI model fine-tuning based on historical data

---

**Built with ❤️ for intelligent effort estimation**
