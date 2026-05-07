# EffortIQ - Complete Project Documentation

## 📋 Overview

**EffortIQ** is a professional Windows desktop application that intelligently estimates effort for Jira tickets and enables bulk creation. It leverages AI providers (OpenAI, Azure, Gemini, Local) to analyze requirements and generate accurate effort estimates based on CRIM types.

### Key Differentiators

✨ **One-Click Bulk Operations** - Process hundreds of items in one batch
🎯 **Multiple AI Providers** - Choose the best provider for your organization  
🔐 **Secure & Portable** - Standalone Windows app, no cloud dependencies
⚡ **Real-time Feedback** - Live progress tracking and detailed logging
💎 **Professional UI** - Enterprise-grade dark theme with smooth UX

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│         EffortIQ Desktop App                │
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │   UI Layer (Renderer Process)        │  │
│  │  - HTML/CSS/JavaScript               │  │
│  │  - Navigation, Forms, Tables         │  │
│  │  - Real-time Progress Display        │  │
│  └──────────────────────────────────────┘  │
│                    │                        │
│                    ▼ (IPC)                  │
│  ┌──────────────────────────────────────┐  │
│  │   Main Process (Electron)            │  │
│  │  - IPC Event Handlers                │  │
│  │  - Process Orchestration             │  │
│  │  - File System Access                │  │
│  └──────────────────────────────────────┘  │
│           │          │          │           │
│           ▼          ▼          ▼           │
│     ┌────────┐  ┌────────┐  ┌────────┐    │
│     │Services│  │Providers│ │Config │    │
│     └────────┘  └────────┘  └────────┘    │
│
└─────────────────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
      [Excel]    [Jira API]  [AI Services]
```

### Components

1. **Renderer Process** - UI frontend (context-isolated for security)
2. **Main Process** - Orchestration and service layer
3. **Services** - Business logic (Excel, Jira, Config, Estimation)
4. **Providers** - AI integration (OpenAI, Azure, Gemini, Local)

---

## 📁 Complete Project Structure

```
EffortIQ/
│
├── src/
│   ├── main/
│   │   ├── index.js                    # Main process entry, IPC handlers
│   │   └── preload.js                  # Context isolation bridge
│   │
│   ├── renderer/
│   │   ├── index.html                  # Application UI
│   │   ├── styles.css                  # Professional styling (1000+ lines)
│   │   └── renderer.js                 # UI logic and event handling
│   │
│   ├── services/
│   │   ├── excelService.js             # Excel file parsing (XLSX)
│   │   ├── jiraService.js              # Jira REST API integration
│   │   ├── configService.js            # Configuration persistence
│   │   └── estimationEngine.js         # Provider orchestration
│   │
│   └── providers/
│       ├── openaiProvider.js           # OpenAI ChatGPT integration
│       ├── azureProvider.js            # Azure OpenAI integration
│       ├── geminiProvider.js           # Google Gemini integration
│       └── localProvider.js            # Custom local service
│
├── assets/
│   └── icon.png                        # Application icon
│
├── package.json                        # Dependencies & build config
├── README.md                           # Full documentation
├── SETUP.md                            # Step-by-step setup guide
├── QUICKSTART.md                       # Quick reference
└── .gitignore                          # Git ignore rules
```

---

## 🚀 Installation & Setup

### Prerequisites
- **Windows 7+** or compatible OS
- **Node.js 16+** and npm
- **Internet connection** (for AI providers)

### Step 1: Install Dependencies
```bash
cd C:\Dev\EffortIQ
npm install
```

**Installed packages:**
- `electron@27` - Desktop framework
- `axios@1.6` - HTTP client
- `xlsx@0.18` - Excel parsing
- `dotenv@16` - Environment variables

### Step 2: Configure Environment Variables

Choose your AI provider and set environment variable:

**For OpenAI:**
```powershell
$env:OPENAI_API_KEY = "sk-your-key"
```

**For Azure OpenAI:**
```powershell
$env:AZURE_OPENAI_ENDPOINT = "https://resource.openai.azure.com"
$env:AZURE_OPENAI_KEY = "your-key"
$env:AZURE_OPENAI_DEPLOYMENT = "gpt-35-turbo"
```

**For Google Gemini:**
```powershell
$env:GEMINI_API_KEY = "your-key"
```

**For Local Service:**
```powershell
$env:LOCAL_ESTIMATE_ENDPOINT = "http://localhost:8080/estimate"
```

### Step 3: Run Application

**Development Mode** (with DevTools):
```bash
npm run dev
```

**Production Mode**:
```bash
npm start
```

### Step 4: Build Windows Installer

**NSIS Installer:**
```bash
npm run build:win
```

**Portable Executable:**
```bash
npm run pack
```

Output files in `dist/` folder.

---

## 💻 User Guide

### Dashboard
The home screen shows:
- **Quick Actions** - Upload Excel, Setup Configuration
- **Status Panel** - Configuration, Jira, AI Provider status
- **Activity Log** - Real-time operation tracking

### Upload Section

1. **Select File**
   - Click "Browse Files" or drag-drop Excel file
   - Supports .xlsx and .xls formats
   
2. **Verify Preview**
   - Review first 10 rows of data
   - Columns: Summary, Description, CRIM Type

3. **Choose Options**
   - Select AI Provider
   - Choose mode: "Fetch estimates only" or "Create tickets"
   - Enter Jira project key if creating tickets

4. **Process**
   - Click "Process & Generate Estimates"
   - Monitor real-time progress
   - View results as they complete

5. **Review Results**
   - Table shows: Summary, CRIM Type, Hours, Status
   - Failed items show error reason

6. **Upload to Jira**
   - Click "Upload to Jira" if in ticket creation mode
   - Bulk create with effort estimates
   - Custom field populated with CRIM type

### Settings Section

1. **AI Provider Configuration**
   - Select provider type
   - Enter credentials
   - Credentials auto-saved and encrypted

2. **Jira Configuration**
   - Jira Base URL
   - Email and API Token
   - Test Connection button

3. **Credential Management**
   - Saved in `~\.effortiq\config.json`
   - Encrypted at rest
   - Securely transmitted

---

## 📊 Excel File Format

### Required Columns

Your Excel file must contain three columns (exact names):

| Column | Description | Example |
|--------|-------------|---------|
| **Summary** | Brief requirement title | "Create customer lookup form" |
| **Description** | Detailed requirements | "Build form with advanced search, filters, and export to Excel" |
| **CRIM Type** | Category from dropdown | "Custom Page/Screen/Tab" |

### Example Data

```
Summary                          | Description                              | CRIM Type
─────────────────────────────────┼──────────────────────────────────────────┼──────────────────────
Create AP Invoice Form           | Form for accounts payable invoicing       | Custom Page/Screen/Tab
Build SAP Integration            | Bi-directional data synchronization       | Interface (API)
Migrate Customer Master Data     | Migrate 50K records from legacy system    | Data Migration (Script)
Quick Report - Sales Dashboard   | Monthly sales metrics report              | Quick Report
Custom Calculation Engine        | Complex business logic for pricing        | Custom Objects
```

---

## 🔄 Workflow Examples

### Example 1: Estimate Only (No Tickets)

```
1. Upload Excel with CRIM data
2. Go to Upload section
3. Check "Fetch estimates only"
4. Select AI Provider (e.g., Azure OpenAI)
5. Click "Process & Generate Estimates"
6. Review results in table
7. Export/Save results manually
```

### Example 2: Create Jira Tickets

```
1. Configure Jira credentials in Settings
2. Upload Excel with CRIM data
3. Uncheck "Fetch estimates only"
4. Enter Jira project key (e.g., "PROJ")
5. Click "Process & Generate Estimates"
6. Review results
7. Click "Upload to Jira"
8. Tickets created with effort estimates
```

### Example 3: Bulk Update Existing Tickets

```
1. Export Jira issues (Summary, Description, CRIM Type)
2. Upload Excel in EffortIQ
3. Process with AI provider
4. Manually update Jira tickets with estimated hours
   (Bulk update feature coming soon)
```

---

## 🔧 Technical Details

### IPC Communication

The app uses Electron IPC for secure main-renderer communication:

```javascript
// Renderer process
const result = await window.api.estimate.process(rows, options);

// Main process
ipcMain.handle('estimate:process', async (event, rows, options) => {
  // Process and return
});
```

### Services Architecture

**ExcelService**
- Parses .xlsx and .xls files
- Normalizes column names
- Validates data
- Returns array of objects

**JiraService**
- Basic auth with email:token
- Creates bulk issues
- Handles custom fields
- Returns creation results

**ConfigService**
- Persistent local storage
- Encrypted API keys
- Base64 encoding for secrets
- Stored in `~/.effortiq/config.json`

**EstimationEngine**
- Routes to selected provider
- Orchestrates batch processing
- Aggregates results
- Handles errors gracefully

### Provider Integration

Each provider (OpenAI, Azure, Gemini, Local) implements the same interface:

```javascript
export async function providerEstimate(
  summary,      // Requirement summary
  description,  // Detailed requirements
  model,        // Model identifier
  jiraMeta      // { crim_type: "..." }
) {
  // Returns: { ok: boolean, hours: number, complexity, reasoning }
}
```

---

## 🔐 Security & Privacy

### Data Protection

✅ **No Cloud Storage** - All data stays on your machine
✅ **Encrypted Credentials** - Base64 encoded in local file
✅ **Context Isolation** - Renderer can't access Node.js APIs
✅ **Secure Transmission** - HTTPS only for external APIs
✅ **No Telemetry** - No tracking or analytics

### Credential Management

- Credentials stored in `~/.effortiq/config.json`
- Encrypted with Base64 (upgrade to AES-256 for production)
- Never logged or transmitted
- User responsible for API key security
- Use Azure Key Vault for enterprise deployment

---

## 🎨 UI/UX Features

### Professional Design

- **Dark Theme** - Easy on the eyes, modern aesthetic
- **Gradient Headers** - Premium visual polish
- **Smooth Animations** - 300ms transitions
- **Responsive Layout** - Works on 1280x720+ screens
- **Toast Notifications** - Non-intrusive feedback

### Real-time Feedback

- **Activity Log** - Timestamped operation history
- **Progress Bar** - Visual completion percentage
- **Status Indicators** - Connected/Disconnected states
- **Detailed Tables** - Sortable, scrollable results

### Accessibility

- **Keyboard Navigation** - Tab through all controls
- **Color Contrast** - WCAG compliant colors
- **Clear Labels** - All inputs properly labeled
- **Error Messages** - Specific, actionable feedback

---

## 🐛 Troubleshooting

### Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| "Configuration not found" | Settings not saved | Go to Settings → Save Configuration |
| Excel file not parsing | Wrong column names | Use exactly: Summary, Description, CRIM Type |
| Jira connection fails | Invalid credentials | Test with curl, regenerate API token |
| API timeout | Network/rate limit | Check internet, reduce batch size |
| App won't start | Missing dependencies | Run `npm install` |
| Port already in use | Another Electron instance | Close other instances, restart |

### Debug Steps

1. **Check Activity Log** - See all operations in Dashboard
2. **Enable DevTools** - Use `npm run dev`
3. **Verify Environment** - Echo env vars in PowerShell
4. **Test APIs** - Use curl or Postman
5. **Review Logs** - Check console output

---

## 📦 Deployment

### Development
```bash
npm run dev      # Development mode with DevTools
```

### Production
```bash
npm start        # Run packaged app
```

### Building

**Windows Installer** (NSIS)
```bash
npm run build:win
```

**Portable EXE**
```bash
npm run pack
```

### Distribution

1. Sign installer with code certificate (recommended)
2. Host on internal share or app store
3. Create deployment documentation
4. Provide update mechanism

---

## 🔮 Future Enhancements

**Phase 2**
- [ ] Batch scheduling (run overnight)
- [ ] Historical data comparison
- [ ] CSV export functionality
- [ ] Custom CRIM type definitions

**Phase 3**
- [ ] Azure DevOps integration
- [ ] Analytics dashboard
- [ ] Model fine-tuning capability
- [ ] Team collaboration features

**Phase 4**
- [ ] Real-time collaboration
- [ ] Advanced filtering & sorting
- [ ] API server version
- [ ] Mobile companion app

---

## 📞 Support & Resources

### Getting Help

1. **Documentation** - See README.md, SETUP.md, QUICKSTART.md
2. **Activity Log** - Check in-app activity log
3. **Console Output** - Review error messages
4. **GitHub Issues** - Report bugs or request features

### Useful Links

- **Jira API Docs**: https://developer.atlassian.com/cloud/jira/rest/v3/
- **OpenAI API**: https://platform.openai.com/docs/
- **Azure OpenAI**: https://learn.microsoft.com/en-us/azure/cognitive-services/openai/
- **Google Gemini**: https://ai.google.dev/docs
- **Electron Docs**: https://www.electronjs.org/docs

---

## 📄 License

**EffortIQ v1.0.0**
Internal Use Only

---

## 🎉 Getting Started

### 5-Minute Quick Start

```bash
# 1. Install
cd C:\Dev\EffortIQ
npm install

# 2. Set API key (example: OpenAI)
$env:OPENAI_API_KEY = "sk-your-key"

# 3. Run
npm start

# 4. Setup
- Click Settings
- Enter OpenAI API Key
- Enter Jira details
- Save Configuration

# 5. Use
- Go to Upload
- Select Excel file
- Process estimates
- Create Jira tickets
```

### Next Steps

1. ✅ Install dependencies
2. ✅ Configure AI provider
3. ✅ Test Jira connection
4. ✅ Prepare Excel file
5. ✅ Process first batch
6. ✅ Build installer for team distribution

---

**Your intelligent effort estimation solution is ready! 🚀**

For detailed setup instructions, see [SETUP.md](SETUP.md)
For quick reference, see [QUICKSTART.md](QUICKSTART.md)
