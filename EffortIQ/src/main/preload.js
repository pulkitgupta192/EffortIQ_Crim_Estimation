/**
 * =========================================================
 * EffortIQ - Preload Script (FINAL)
 * ---------------------------------------------------------
 * Secure bridge between Renderer <-> Main process
 * - Context Isolation: ✅ ON
 * - Node Integration: ❌ OFF
 *
 * Exposes:
 *  - excel.parse
 *  - config.save / load
 *  - estimate.process / onProgress
 *  - jira.testConnection / listProjects / createTickets
 *  - shell.openExternal
 *  - sfd.parse / extract / classify / estimate
 * =========================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------
// Small helper to safely expose invoke-based APIs
// ---------------------------------------------------------
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

// ---------------------------------------------------------
// Event subscriptions (progress callbacks)
// ---------------------------------------------------------
function on(channel, listener) {
  const wrapped = (_event, data) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// ---------------------------------------------------------
// Exposed API
// ---------------------------------------------------------
contextBridge.exposeInMainWorld('api', {
  // -------------------------
  // Excel / File parsing
  // -------------------------
  excel: {
    /**
     * Parse Excel file (.xlsx / .xls)
     * @param {string} filePath
     */
    parse: (filePath) =>
      invoke('excel:parse', filePath),
  },

  // -------------------------
  // Configuration (persisted)
  // -------------------------
  config: {
    /**
     * Save whole configuration object
     * @param {object} config
     */
    save: (config) =>
      invoke('config:save', config),

    /**
     * Load persisted configuration
     */
    load: () =>
      invoke('config:load'),
  },

  // -------------------------
  // CRIM Estimation Engine
  // -------------------------
  estimate: {
    /**
     * Process CRIM rows and generate estimates
     * @param {Array} rows
     * @param {object} options
     */
    process: (rows, options) =>
      invoke('estimate:process', rows, options),

    /**
     * Subscribe to live progress
     * callback receives: { index, total, percent, message }
     */
    onProgress: (callback) =>
      on('estimate:progress', callback),
  },

  // -------------------------
  // Jira Integration
  // -------------------------
  jira: {
    /**
     * Test Jira credentials
     * @param {object} jiraConfig
     */
    testConnection: (jiraConfig) =>
      invoke('jira:test-connection', jiraConfig),

    /**
     * List Jira projects user has access to
     * @param {object} jiraConfig
     * @param {object} options
     */
    listProjects: (jiraConfig, options = {}) =>
      invoke('jira:list-projects', jiraConfig, options),

    /**
     * Bulk create Jira tickets
     * @param {Array} tickets
     * @param {object} jiraConfig
     * @param {object} options
     */
    createTickets: (tickets, jiraConfig, options = {}) =>
      invoke('jira:create-tickets', tickets, jiraConfig, options),
  },

  // -------------------------
  // System / OS helpers
  // -------------------------
  shell: {
    /**
     * Open external URL in default browser
     * @param {string} url
     */
    openExternal: (url) =>
      invoke('shell:open-external', url),
  },

	// -------------------------
	// SFD Estimation Module
	// -------------------------
	sfd: {
	browse: () => invoke('sfd:browse'),

	/**
	* Parse SFD document (PDF / DOCX / TXT / MD)
	* @param {string} filePath
	*/
	parse: (filePath) =>
		invoke('sfd:parse', filePath),
	
	/**
	* Extract implementation activities from parsed SFD text
	* @param {string} text
	* @param {{ maxActivities?: number }} options
	*/
	extract: (text, options) =>
		invoke('sfd:extract', text, options),
	
	/**
	* Classify activities using AI (subtype + complexity)
	* @param {Array} activities
	* @param {'openai'|'azure'|'gemini'|'local'} provider
	* @param {object} providerConfig
	* @param {{ batchSize?: number, includeSourceHints?: boolean }} options
	*/
	classify: (activities, provider, providerConfig, options) =>
		invoke('sfd:classify', activities, provider, providerConfig, options),
	
	/**
	* Deterministic effort estimation (NO AI here)
	* @param {Array} classifiedActivities
	*/
	estimate: (classifiedActivities) =>
		invoke('sfd:estimate', classifiedActivities),
	
	// -------------------------
	// Optional: Source Dive helpers
	// -------------------------
	
	/**
	* Index local source directory (optional feature)
	* @param {{ localDir: string, maxFiles?: number }} opts
	*/
	sourceIndex: (opts) =>
		invoke('sfd:sourceIndex', opts),
	
	/**
	* Suggest impacted files for a given activity
	* @param {object} activity
	* @param {object} sourceIndex
	*/
	suggestFiles: (activity, sourceIndex) =>
		invoke('sfd:suggestFiles', activity, sourceIndex),
  },
});