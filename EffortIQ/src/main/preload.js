// src/main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

contextBridge.exposeInMainWorld('api', {
  excel: {
    parse: (filePath) => invoke('excel:parse', filePath),
  },
  config: {
    save: (config) => invoke('config:save', config),
    load: () => invoke('config:load'),
  },
  estimate: {
    process: (rows, options) => invoke('estimate:process', rows, options),
    onProgress: (cb) =>
      ipcRenderer.on('estimate:progress', (_e, payload) => cb(payload)),
  },

  // ✅ NEW: SFD estimation
  sfd: {
    process: (filePath, options) => invoke('sfd:process', filePath, options),
  },

  jira: {
    testConnection: (jiraConfig) => invoke('jira:testConnection', jiraConfig),
    listProjects: (jiraConfig, options) => invoke('jira:listProjects', jiraConfig, options),
    createTickets: (tickets, jiraConfig, options) =>
      invoke('jira:createTickets', tickets, jiraConfig, options),
  },
  
  ai: {
    testProvider: (provider, config) =>
  	invoke('ai:testProvider', provider, config),
  },

  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
  },
});