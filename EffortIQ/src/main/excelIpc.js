'use strict';
const { ipcMain, dialog } = require('electron');

function registerExcelIpcHandlers(mainWindow) {
  ipcMain.handle('excel:browse', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Excel file',
      properties: ['openFile'],
      filters: [
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (res.canceled) return { ok: false, error: 'Selection cancelled' };
    const filePath = res.filePaths?.[0];
    if (!filePath) return { ok: false, error: 'No file selected' };
    return { ok: true, filePath };
  });
}

module.exports = { registerExcelIpcHandlers };