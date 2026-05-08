// src/main/index.js
// =========================================================
// EffortIQ - Electron Main Process
// - Creates BrowserWindow
// - Registers IPC handlers (excel/config/estimate/sfd/jira)
// =========================================================
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

const { excelService } = require('../services/excelService.js');
const { jiraService } = require('../services/jiraService.js');
const { configService } = require('../services/configService.js');
const { estimationEngine } = require('../services/estimationEngine.js');

// ✅ NEW: SFD Estimation Engine
const { sfdEstimationEngine } = require('../services/sfdEstimationEngine.js');

let mainWindow;

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Exit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About EffortIQ',
          click: () => {
            // Optional: implement an About dialog
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  });

  const isDev = !app.isPackaged;
  const rendererHtmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(rendererHtmlPath);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createMenu();
}

// =========================================================
// IPC Handlers
// =========================================================

// Excel
ipcMain.handle('excel:parse', async (_event, filePath) => {
  try {
    const data = await excelService.parseExcel(filePath);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Config
ipcMain.handle('config:save', async (_event, config) => {
  try {
    await configService.saveConfig(config);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('config:load', async () => {
  try {
    return await configService.loadConfig();
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Estimation (Excel rows)
ipcMain.handle('estimate:process', async (event, rows, options) => {
  try {
    const results = await estimationEngine.processRows(rows, options, (progress) => {
      event.sender.send('estimate:progress', progress);
    });
    return { ok: true, data: results };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ✅ NEW: SFD Estimation (DOCX file)
ipcMain.handle('sfd:process', async (event, filePath, options) => {
  try {
    const resp = await sfdEstimationEngine.processSfdFile(filePath, options, (progress) => {
      // Reuse same progress channel used by renderer
      event.sender.send('estimate:progress', {
        ...progress,
        // normalize indices for UI if missing
        index: progress?.index ?? 0,
        total: progress?.total ?? 0,
        percent: progress?.percent ?? 0,
      });
    });
    return resp?.ok ? { ok: true, data: resp.data } : { ok: false, error: resp.error || 'SFD estimation failed' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Jira
ipcMain.handle('jira:testConnection', async (_event, config) => {
  try {
    const result = await jiraService.testConnection(config);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Shell / External Links
ipcMain.handle('shell:openExternal', async (_event, url) => {
  try {
    const { shell } = require('electron');
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false, error: 'Invalid URL' };
    }
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// IMPORTANT: supports 3rd argument `options` (crimFieldName, failIfCrimFieldMissing)
ipcMain.handle('jira:createTickets', async (_event, tickets, jiraConfig, options) => {
  try {
    const result = await jiraService.createBulkTickets(tickets, jiraConfig, options);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Jira Project List (for dropdown)
ipcMain.handle('jira:listProjects', async (_event, jiraConfig, options) => {
  try {
    const result = await jiraService.listProjects(jiraConfig, options);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// =========================================================
// App lifecycle
// =========================================================
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});