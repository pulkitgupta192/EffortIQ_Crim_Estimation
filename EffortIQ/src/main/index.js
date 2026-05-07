// src/main/index.js
// =========================================================
// EffortIQ - Electron Main Process (FINAL FIXED)
// =========================================================

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');

// ------------------------------
// Services (existing structure)
// ------------------------------
const { dialog } = require('electron');
const { excelService } = require('../services/excelService.js');
const { jiraService } = require('../services/jiraService.js');
const { configService } = require('../services/configService.js');
const { estimationEngine } = require('../services/estimationEngine.js');
const sfdService = require('../services/sfd');

// ------------------------------
// Window & Menu
// ------------------------------
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
      submenu: [{ label: 'About EffortIQ' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createMenu();
}

// =========================================================
// IPC HANDLERS (MATCHES preload.js EXACTLY)
// =========================================================

ipcMain.handle('sfd:browse', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select SFD Document',
    properties: ['openFile'],
    filters: [
      { name: 'SFD Documents', extensions: ['docx', 'pdf', 'txt', 'md'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) {
    return { ok: false, error: 'No file selected' };
  }

  return { ok: true, filePath: result.filePaths[0] };
});


// ---------------- Excel ----------------
ipcMain.handle('excel:parse', async (_event, filePath) => {
  try {
    const data = await excelService.parseExcel(filePath);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ---------------- Config ----------------
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

// ---------------- CRIM Estimation ----------------
ipcMain.handle('estimate:process', async (event, rows, options) => {
  try {
    const results = await estimationEngine.processRows(
      rows,
      options,
      progress => event.sender.send('estimate:progress', progress)
    );
    return { ok: true, data: results };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ---------------- Jira (✅ FIXED NAMES) ----------------
ipcMain.handle('jira:test-connection', async (_event, config) => {
  try {
    const result = await jiraService.testConnection(config);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('jira:list-projects', async (_event, jiraConfig, options) => {
  try {
    const result = await jiraService.listProjects(jiraConfig, options);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('jira:create-tickets', async (_event, tickets, jiraConfig, options) => {
  try {
    const result = await jiraService.createBulkTickets(
      tickets,
      jiraConfig,
      options
    );
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ---------------- SFD (✅ ADDED) ----------------
ipcMain.handle('sfd:parse', async (_event, filePath) => {
  try {
    return await sfdService.parseSfd(filePath);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('sfd:extract', async (_event, text, options) => {
  try {
    const activities = sfdService.extractActivitiesHeuristic(text, options);
    return { ok: true, data: activities };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('sfd:classify', async (_event, activities, provider, providerConfig, options) => {
  try {
    return await sfdService.classifyActivities(
      activities,
      provider,
      providerConfig,
      options
    );
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('sfd:estimate', async (_event, classifiedActivities) => {
  try {
    const result = sfdService.estimateActivities(classifiedActivities);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ---------------- Shell / External ----------------
ipcMain.handle('shell:open-external', async (_event, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ---------------- App lifecycle ----------------
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
