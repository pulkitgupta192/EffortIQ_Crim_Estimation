SETUP INSTRUCTIONS FOR EFFORTIQ
=================================

STEP 1: INSTALL DEPENDENCIES
-----------------------------
Open PowerShell or Command Prompt and run:

cd C:\Dev\EffortIQ
npm install

This will install all required packages including:
- Electron (desktop framework)
- XLSX (Excel parsing)
- Axios (HTTP requests)
- And other dependencies

STEP 2: SET ENVIRONMENT VARIABLES
----------------------------------

Choose your AI provider and set the appropriate variables:

FOR OPENAI (GPT-4o-mini):
$env:OPENAI_API_KEY = "sk-your-api-key-here"

FOR AZURE OPENAI:
$env:AZURE_OPENAI_ENDPOINT = "https://your-resource.openai.azure.com"
$env:AZURE_OPENAI_KEY = "your-azure-key"
$env:AZURE_OPENAI_DEPLOYMENT = "deployment-name"
$env:AZURE_OPENAI_API_VERSION = "2024-06-01"

FOR GOOGLE GEMINI:
$env:GEMINI_API_KEY = "your-gemini-key"

FOR LOCAL SERVICE:
$env:LOCAL_ESTIMATE_ENDPOINT = "http://localhost:8080/estimate"

STEP 3: RUN THE APPLICATION
----------------------------

For development (with DevTools):
npm run dev

For production:
npm start

STEP 4: CONFIGURE IN APP
------------------------
1. Go to Settings section
2. Enter your AI provider credentials
3. Enter Jira connection details
4. Test Jira connection
5. Save configuration

STEP 5: USE THE APP
-------------------
1. Go to Upload section
2. Select your Excel file with columns:
   - Summary
   - Description
   - CRIM Type
3. Choose processing mode (estimate only or create tickets)
4. Click "Process & Generate Estimates"
5. Review results
6. Upload to Jira if desired

BUILDING WINDOWS INSTALLER
---------------------------

For NSIS Installer:
npm run build:win

For Portable Executable:
npm run pack

The installer will be in the dist/ folder.

TROUBLESHOOTING
---------------

1. Port already in use?
   - Close other Electron instances
   - Try: npm start --reset-cache

2. API Key errors?
   - Double-check environment variables are set
   - Restart PowerShell/CMD after setting env vars
   - Use Azure Key Vault for sensitive data

3. Jira connection fails?
   - Verify Jira URL format
   - Check API token hasn't expired
   - Test with curl first:
     curl -X GET https://yourjira/rest/api/3/myself -H "Authorization: Basic BASE64_ENCODED_CREDENTIALS"

4. Excel parsing issues?
   - Ensure columns are named exactly: Summary, Description, CRIM Type
   - Remove empty rows
   - Use .xlsx format (newer Excel versions)

CONFIGURATION FILE LOCATION
----------------------------
C:\Users\YourUsername\.effortiq\config.json

This file stores your credentials (encrypted).

FILE STRUCTURE
--------------
EffortIQ/
├── src/
│   ├── main/          → Electron main process
│   ├── renderer/      → UI and frontend logic  
│   ├── services/      → Business logic (Excel, Jira, Config, Estimation)
│   └── providers/     → AI provider implementations
├── assets/            → App icons and resources
├── package.json       → Dependencies and build config
└── README.md          → Full documentation

API PROVIDERS REFERENCE
-----------------------

OpenAI: https://platform.openai.com/api-keys
Azure OpenAI: https://portal.azure.com
Google Gemini: https://ai.google.dev/
Local: Your own HTTP service

JIRA API SETUP
---------------
1. Generate API token: https://id.atlassian.com/manage-profile/security/api-tokens
2. Use format: email:token
3. Base64 encode for Basic auth
4. Verify with Jira REST API: /rest/api/3/myself

EXCEL FILE FORMAT
------------------
Your Excel should have columns:
- Summary (required) - Brief description of work
- Description (required) - Detailed requirements
- CRIM Type (required) - Type from dropdown list

Example:
Summary: "Create custom form for AP"
Description: "Build form to capture accounts payable data with validations"
CRIM Type: "Custom Page/Screen/Tab"

NEXT STEPS
----------
1. Complete setup above
2. Prepare Excel file with CRIM data
3. Launch app
4. Configure AI provider
5. Upload Excel file
6. Generate estimates
7. Review and create Jira tickets
8. Monitor ticket creation status

For more help, see README.md in the EffortIQ folder.
