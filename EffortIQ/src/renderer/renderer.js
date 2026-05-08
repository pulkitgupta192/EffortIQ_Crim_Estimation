// ============================================
// EffortIQ - Renderer Process (UI Logic)
// - XLSX High Level Estimation (existing flow)
// - SFD DOCX Estimation (new flow)
// - Jira upload:
//   - XLSX: bulk create tickets (existing)
//   - SFD: create ONE ticket, upload TOTAL WBS + set estimate + attach SFD DOCX
//
// Defensive design:
// - If some optional elements do not exist in index.html, this file will not crash.
// ============================================
(() => {
  'use strict';

  console.log('[EffortIQ] Renderer loaded');

  // ---------------------------------------------------------
  // Debug toggle
  // Enable: localStorage.setItem('effortiq:debug','1'); location.reload();
  // Disable: localStorage.removeItem('effortiq:debug'); location.reload();
  // ---------------------------------------------------------
  const DEBUG = localStorage.getItem('effortiq:debug') === '1';
  const log = (...args) => DEBUG && console.log('[EffortIQ]', ...args);
  const warn = (...args) => DEBUG && console.warn('[EffortIQ]', ...args);
  const errorLog = (...args) => console.error('[EffortIQ]', ...args);

  // ---------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.style.display = 'block'; };
  const hide = (el) => { if (el) el.style.display = 'none'; };
  const enable = (el) => { if (el) el.disabled = false; };
  const disable = (el) => { if (el) el.disabled = true; };

  function escapeHtml(input) {
    const s = String(input ?? '');
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  let currentConfig = {};
  let uploadedData = [];         // XLSX parsed rows
  let previewVirtual = null;
  let estimationResults = [];    // results rows (XLSX or SFD)
  const expandedRows = new Set();

  // Mode + uploaded file
  // mode: 'xlsx' | 'sfd'
  let currentMode = 'xlsx';
  let uploadedFile = null;       // { path, name, mode }

  // Modal state
  let modalActiveRow = null;
  let modalActiveTab = 'wbs';

  // Progress subscription guard
  let progressSubscribed = false;

  // ---------------------------------------------------------
  // Toast + Activity Log
  // ---------------------------------------------------------
  function showToast(message, type = 'info', duration = 3000) {
    const toast = $('toast');
    if (!toast) {
      // fallback
      alert(message);
      return;
    }
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  function addActivityLog(message, type = 'info') {
    const logContainer = $('activityLog');
    if (!logContainer) return;

    const empty = logContainer.querySelector('.empty-state');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = `activity-item ${type}`;
    const time = new Date().toLocaleTimeString();
    item.textContent = `[${time}] ${message}`;

    logContainer.insertBefore(item, logContainer.firstChild);
    while (logContainer.children.length > 10) {
      logContainer.removeChild(logContainer.lastChild);
    }
  }

  // ---------------------------------------------------------
  // Section navigation
  // ---------------------------------------------------------
  function showSection(sectionId) {
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    const section = $(`section-${sectionId}`);
    if (section) section.classList.add('active');

    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.remove('active');
      if (item.dataset.section === sectionId) item.classList.add('active');
    });
  }

  // ---------------------------------------------------------
  // Status panel
  // ---------------------------------------------------------
  function updateStatus() {
    const configStatus = $('configStatus');
    const jiraStatus = $('jiraStatus');
    const providerStatus = $('providerStatus');

    if (providerStatus) {
      providerStatus.textContent = currentConfig.provider
        ? `✅ ${String(currentConfig.provider).toUpperCase()}`
        : '❌ Not Configured';
    }
    if (jiraStatus) {
      jiraStatus.textContent = currentConfig.jira?.url ? '✅ Configured' : '❌ Not Connected';
    }
    if (configStatus) {
      configStatus.textContent = Object.keys(currentConfig).length ? '✅ Configured' : '❌ Not Set';
    }
  }

  // ---------------------------------------------------------
  // API readiness (preload bridge)
  // ---------------------------------------------------------
  async function waitForAPI(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const api = window.api;
      if (
        api &&
        typeof api.excel?.parse === 'function' &&
        typeof api.config?.save === 'function' &&
        typeof api.config?.load === 'function' &&
        typeof api.estimate?.process === 'function' &&
        typeof api.jira?.testConnection === 'function' &&
        typeof api.jira?.listProjects === 'function' &&
        typeof api.jira?.createTickets === 'function'
      ) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  // ---------------------------------------------------------
  // Provider config UI switching
  // ---------------------------------------------------------
  function showProviderConfig(provider) {
    document.querySelectorAll('.provider-config').forEach((node) => {
      node.classList.remove('active');
      node.style.display = 'none';
    });
    const active = $(`${provider}-config`);
    if (active) {
      active.classList.add('active');
      active.style.display = 'block';
    }
  }

  // ---------------------------------------------------------
  // Jira projects dropdown
  // ---------------------------------------------------------
  function buildJiraTicketsUrl(jiraBaseUrl, issueKeys = []) {
    const base = String(jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base || !Array.isArray(issueKeys) || issueKeys.length === 0) return null;
    const keys = issueKeys.filter(Boolean).join(',');
    const jql = `key in (${keys})`;
    return `${base}/issues/?jql=${encodeURIComponent(jql)}`;
  }

  function showViewJiraTicketsButton(jiraUrl, issueKeys) {
    const container = document.getElementById('uploadJiraBtn')?.parentElement;
    if (!container) return;

    const existing = document.getElementById('viewJiraTicketsBtn');
    if (existing) existing.remove();

    const url = buildJiraTicketsUrl(jiraUrl, issueKeys);
    if (!url) return;

    const btn = document.createElement('button');
    btn.id = 'viewJiraTicketsBtn';
    btn.className = 'btn btn-outline';
    btn.type = 'button';
    btn.textContent = `🔗 View Jira Tickets (${issueKeys.length})`;
    btn.addEventListener('click', async () => {
      const res = await window.api?.shell?.openExternal?.(url);
      if (!res?.ok) {
        showToast(`❌ Failed to open Jira: ${res?.error || 'Unknown error'}`, 'error', 7000);
      }
    });

    container.appendChild(btn);
  }

  function setProjectSelectMessage(message) {
    const select = $('jiraProjectSelect');
    if (!select) return;
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = message;
    select.appendChild(opt);
  }

  function populateProjectDropdown(projects) {
    const select = $('jiraProjectSelect');
    if (!select) return;

    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a project...';
    select.appendChild(placeholder);

    (projects || []).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = `${p.key} — ${p.name}`;
      select.appendChild(opt);
    });
  }

  async function fetchAndBindProjects(jiraConfig) {
    const select = $('jiraProjectSelect');
    if (!select) return;

    if (!jiraConfig?.url || !jiraConfig?.email || !jiraConfig?.token) {
      setProjectSelectMessage('Configure Jira first (Settings)');
      return;
    }

    setProjectSelectMessage('Loading projects...');
    const res = await window.api.jira.listProjects(jiraConfig, { maxResults: 200 });

    if (!res?.ok) {
      setProjectSelectMessage('Failed to load projects');
      showToast(`❌ Failed to load Jira projects: ${res?.error || 'Unknown error'}`, 'error', 7000);
      addActivityLog(`Failed to load Jira projects: ${res?.error || 'Unknown error'}`, 'error');
      return;
    }

    const data = res.data;
    if (!data?.ok) {
      setProjectSelectMessage('Failed to load projects');
      showToast(`❌ Failed to load Jira projects: ${data?.error || 'Unknown error'}`, 'error', 7000);
      addActivityLog(`Failed to load Jira projects: ${data?.error || 'Unknown error'}`, 'error');
      return;
    }

    const projects = data.projects || [];
    populateProjectDropdown(projects);
    addActivityLog(`Loaded ${projects.length} Jira projects`, 'success');

    if (projects.length === 1) select.value = projects[0].key;
  }

  // ---------------------------------------------------------
  // Config save/load
  // ---------------------------------------------------------
  async function saveConfiguration() {
    const provider = $('providerType')?.value || 'openai';
    const cfg = { provider };

    if (provider === 'openai') {
      cfg.openai = {
        apiKey: $('openaiKey')?.value || '',
        model: $('openaiModel')?.value || 'gpt-4o-mini',
      };
    } else if (provider === 'azure') {
      cfg.azure = {
        endpoint: $('azureEndpoint')?.value || '',
        apiKey: $('azureKey')?.value || '',
        deployment: $('azureDeployment')?.value || '',
        apiVersion: $('azureApiVersion')?.value || '2024-06-01',
      };
    } else if (provider === 'gemini') {
      cfg.gemini = {
        apiKey: $('geminiKey')?.value || '',
        model: $('geminiModel')?.value || 'gemini-1.5-pro',
      };
    } else if (provider === 'local') {
      cfg.local = { endpoint: $('localEndpoint')?.value || '' };
    }

    cfg.jira = {
      url: $('jiraUrl')?.value || '',
      email: $('jiraEmail')?.value || '',
      token: $('jiraToken')?.value || '',
    };

    try {
      const result = await window.api.config.save(cfg);
      if (result.ok) {
        currentConfig = cfg;
        showToast('✅ Configuration saved', 'success', 2000);
        addActivityLog('Configuration saved', 'success');
        updateStatus();
        await fetchAndBindProjects(currentConfig.jira);
      } else {
        showToast(`❌ Save failed: ${result.error}`, 'error', 7000);
        addActivityLog(`Save failed: ${result.error}`, 'error');
      }
    } catch (e) {
      showToast(`❌ Save failed: ${e.message}`, 'error', 7000);
      addActivityLog(`Save failed: ${e.message}`, 'error');
    }
  }

  async function loadConfiguration() {
    try {
      const result = await window.api.config.load();
      if (!result.ok || !result.data) return;

      currentConfig = result.data;

      if (currentConfig.provider && $('providerType')) {
        $('providerType').value = currentConfig.provider;
        showProviderConfig(currentConfig.provider);
      }

      if (currentConfig.openai) {
        $('openaiKey') && ($('openaiKey').value = currentConfig.openai.apiKey || '');
        $('openaiModel') && ($('openaiModel').value = currentConfig.openai.model || 'gpt-4o-mini');
      }
      if (currentConfig.azure) {
        $('azureEndpoint') && ($('azureEndpoint').value = currentConfig.azure.endpoint || '');
        $('azureKey') && ($('azureKey').value = currentConfig.azure.apiKey || '');
        $('azureDeployment') && ($('azureDeployment').value = currentConfig.azure.deployment || '');
        $('azureApiVersion') && ($('azureApiVersion').value = currentConfig.azure.apiVersion || '2024-06-01');
      }
      if (currentConfig.gemini) {
        $('geminiKey') && ($('geminiKey').value = currentConfig.gemini.apiKey || '');
        $('geminiModel') && ($('geminiModel').value = currentConfig.gemini.model || 'gemini-1.5-pro');
      }
      if (currentConfig.local) {
        $('localEndpoint') && ($('localEndpoint').value = currentConfig.local.endpoint || '');
      }
      if (currentConfig.jira) {
        $('jiraUrl') && ($('jiraUrl').value = currentConfig.jira.url || '');
        $('jiraEmail') && ($('jiraEmail').value = currentConfig.jira.email || '');
        $('jiraToken') && ($('jiraToken').value = currentConfig.jira.token || '');
      }

      updateStatus();
      if (currentConfig.jira?.url) await fetchAndBindProjects(currentConfig.jira);
    } catch (e) {
      warn('Load config failed:', e);
    }
  }

  // ---------------------------------------------------------
  // Mode handling (defensive)
  // ---------------------------------------------------------
  function getModeFromUI() {
    const m = $('estimationMode')?.value;
    if (!m) return currentMode || 'xlsx';
    return (String(m).toLowerCase() === 'sfd') ? 'sfd' : 'xlsx';
  }

  function applyModeToUI(mode) {
    currentMode = (mode === 'sfd') ? 'sfd' : 'xlsx';

    // Optional UI controls (if your index.html supports them)
    const fileInput = $('fileInput');
    const dropzoneText = $('dropzoneText');
    const dropzoneIcon = $('dropzoneIcon');
    const sfdNote = $('sfdProviderNote');

    // Reset upload state
    uploadedFile = null;
    uploadedData = [];
    if (fileInput) fileInput.value = '';

    // Hide preview for mode switch
    hide($('previewCard'));

    if (currentMode === 'xlsx') {
      if (fileInput) fileInput.accept = '.xlsx,.xls';
      if (dropzoneText) dropzoneText.textContent = 'Drag & drop your Excel file here';
      if (dropzoneIcon) dropzoneIcon.textContent = '📊';
      if (sfdNote) sfdNote.style.display = 'none';
    } else {
      if (fileInput) fileInput.accept = '.docx';
      if (dropzoneText) dropzoneText.textContent = 'Drag & drop your SFD DOCX file here';
      if (dropzoneIcon) dropzoneIcon.textContent = '📄';
      if (sfdNote) sfdNote.style.display = 'block';
    }

    // Clear results area on mode switch (do not hide mode card)
    resetProcessingUI(false);
  }

  function setSelectedFileLabel(text) {
    const label = $('selectedFileLabel');
    if (!label) return;
    if (!text) {
      label.style.display = 'none';
      label.textContent = '';
      return;
    }
    label.style.display = 'block';
    label.textContent = text;
  }

  // ---------------------------------------------------------
  // Excel upload + preview (virtualized)
  // ---------------------------------------------------------
  function displayPreview(data) {
    const previewCard = $('previewCard');
    const optionsCard = $('optionsCard');

    // Only show preview for XLSX mode
    if (currentMode !== 'xlsx') {
      hide(previewCard);
      show(optionsCard);
      return;
    }

    show(previewCard);
    show(optionsCard);

    // Destroy old virtual preview
    if (previewVirtual && typeof previewVirtual.destroy === 'function') {
      previewVirtual.destroy();
    }

    previewVirtual = createVirtualizedPreview({
      data: Array.isArray(data) ? data : [],
      wrapper: $('previewTableWrapper') || $('previewTable')?.closest('.table-wrapper'),
      tbody: $('previewTableBody'),
      countLabel: $('previewCount'),
      rowHeight: 56,
      overscan: 10,
    });

    previewVirtual.render();
  }

  function createVirtualizedPreview({
    data,
    wrapper,
    tbody,
    countLabel,
    rowHeight = 56,
    overscan = 10,
  }) {
    if (!wrapper || !tbody) return { render: () => {}, destroy: () => {} };

    wrapper.classList.add('preview-virtual');

    let lastStart = -1;
    let ticking = false;

    // Spacer rows
    const topSpacerTr = document.createElement('tr');
    topSpacerTr.className = 'vspacer';
    const topSpacerTd = document.createElement('td');
    topSpacerTd.colSpan = 3;
    topSpacerTr.appendChild(topSpacerTd);

    const bottomSpacerTr = document.createElement('tr');
    bottomSpacerTr.className = 'vspacer';
    const bottomSpacerTd = document.createElement('td');
    bottomSpacerTd.colSpan = 3;
    bottomSpacerTr.appendChild(bottomSpacerTd);

    function setCountLabel(startIdx, endIdx, total) {
      if (!countLabel) return;
      if (total === 0) {
        countLabel.textContent = 'No rows found in the file.';
        return;
      }
      const s = Math.min(startIdx + 1, total);
      const e = Math.min(endIdx, total);
      countLabel.textContent = `Showing rows ${s}–${e} of ${total}`;
    }

    function render() {
      const total = data.length;
      const viewportH = wrapper.clientHeight || 300;
      const scrollTop = wrapper.scrollTop || 0;

      const visibleCount = Math.ceil(viewportH / rowHeight);
      let start = Math.floor(scrollTop / rowHeight) - overscan;
      start = Math.max(0, start);

      let end = start + visibleCount + (overscan * 2);
      end = Math.min(total, end);

      if (start === lastStart && tbody.childNodes.length > 0) {
        setCountLabel(start, end, total);
        return;
      }
      lastStart = start;

      const topH = start * rowHeight;
      const bottomH = (total - end) * rowHeight;
      topSpacerTd.style.height = `${topH}px`;
      bottomSpacerTd.style.height = `${bottomH}px`;

      const frag = document.createDocumentFragment();
      frag.appendChild(topSpacerTr);

      for (let i = start; i < end; i++) {
        const row = data[i] || {};
        const tr = document.createElement('tr');
        tr.className = 'preview-row';

        const summary = escapeHtml(row.summary || '');
        const crim = escapeHtml(row.crim_type || '');
        const descRaw = String(row.description || '');
        const desc = escapeHtml(descRaw.replace(/\r?\n/g, ' '));

        tr.innerHTML = `
          <td>${summary}</td>
          <td class="preview-desc"><span class="clamp-1">${desc}</span></td>
          <td>${crim}</td>
        `;
        frag.appendChild(tr);
      }

      frag.appendChild(bottomSpacerTr);
      tbody.innerHTML = '';
      tbody.appendChild(frag);

      setCountLabel(start, end, total);
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        render();
      });
    }

    const ro = new ResizeObserver(() => render());
    ro.observe(wrapper);
    wrapper.addEventListener('scroll', onScroll, { passive: true });

    return {
      render,
      destroy: () => {
        wrapper.removeEventListener('scroll', onScroll);
        ro.disconnect();
      },
    };
  }

  // ---------------------------------------------------------
  // File upload handler (XLSX or DOCX)
  // ---------------------------------------------------------
  async function handleFileUpload(file) {
    if (!file) return;

    // Mode is always taken from UI (if present)
    currentMode = getModeFromUI();

    // Always clear old results on new upload
    resetProcessingUI(false);

    uploadedFile = { path: file.path, name: file.name, mode: currentMode };
    setSelectedFileLabel(`Selected: ${file.name}`);

    if (currentMode === 'xlsx') {
      if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
        showToast('❌ Please upload an Excel file (.xlsx or .xls)', 'error', 6000);
        addActivityLog('Invalid file selected (expected XLSX/XLS)', 'error');
        return;
      }

      showToast('📂 Reading Excel file...', 'info', 2000);
      addActivityLog(`Uploading file: ${file.name}`, 'info');

      try {
        const result = await window.api.excel.parse(file.path);
        if (!result.ok) {
          showToast(`❌ Excel parse failed: ${result.error}`, 'error', 8000);
          addActivityLog(`Excel parse failed: ${result.error}`, 'error');
          return;
        }

        uploadedData = result.data || [];
        displayPreview(uploadedData);

        showToast(`✅ Loaded ${uploadedData.length} rows`, 'success', 2500);
        addActivityLog(`Loaded ${uploadedData.length} rows`, 'success');
      } catch (e) {
        showToast(`❌ Excel parse failed: ${e.message}`, 'error', 8000);
        addActivityLog(`Excel parse failed: ${e.message}`, 'error');
      }
    } else {
      // SFD mode
      if (!file.name.toLowerCase().endsWith('.docx')) {
        showToast('❌ Please upload an SFD DOCX file (.docx)', 'error', 6000);
        addActivityLog('Invalid file selected (expected DOCX)', 'error');
        return;
      }

      // No preview for DOCX
      hide($('previewCard'));
      show($('optionsCard'));

      showToast('✅ SFD DOCX selected. Ready to estimate.', 'success', 2500);
      addActivityLog(`SFD selected: ${file.name}`, 'success');
    }
  }

  // ---------------------------------------------------------
  // Live progress handler (shared channel estimate:progress)
  // ---------------------------------------------------------
  function bindLiveProgressOnce() {
    if (progressSubscribed) return;
    if (!window.api?.estimate?.onProgress) return;

    window.api.estimate.onProgress((p) => {
      const fill = $('progressFill');
      const text = $('progressText');
      if (!fill || !text) return;

      const percent = Number.isFinite(p?.percent) ? p.percent : 0;
      fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;

      const idx = p?.index ?? 0;
      const total = p?.total ?? 0;

      text.textContent = `${p?.message || 'Processing...'} (${idx}/${total}, ${percent}%)`;
    });

    progressSubscribed = true;
  }

  // ---------------------------------------------------------
  // Estimation entrypoint (mode aware)
  // ---------------------------------------------------------
  async function processEstimates() {
    currentMode = getModeFromUI();

    const selectedProvider = $('aiProvider')?.value || currentConfig.provider;

    if (!selectedProvider) {
      showToast('❌ Please configure an AI provider first (Settings)', 'error', 7000);
      return;
    }

    if (!uploadedFile?.path) {
      showToast('❌ Please upload a file first', 'error', 6000);
      return;
    }

    const estimateOnly = Boolean($('estimateOnly')?.checked);
    const projectKey = ($('jiraProjectSelect')?.value || '').trim();

    if (!estimateOnly && !projectKey) {
      showToast('❌ Please select a Jira project', 'error', 6000);
      return;
    }

    show($('resultsCard'));
    disable($('processBtn'));
    hide($('uploadJiraBtn')); // re-enable after success if needed

    showToast('⚡ Processing estimates...', 'info', 2000);
    addActivityLog(`Estimating (${currentMode.toUpperCase()})`, 'info');

    try {
      const providerConfig = currentConfig[selectedProvider] || {};

      if (currentMode === 'xlsx') {
        if (!uploadedData || uploadedData.length === 0) {
          enable($('processBtn'));
          showToast('❌ No Excel rows to process', 'error', 6000);
          addActivityLog('No Excel rows available for estimation', 'error');
          return;
        }

        const result = await window.api.estimate.process(uploadedData, {
          provider: selectedProvider,
          config: providerConfig,
          estimateOnly,
        });

        enable($('processBtn'));

        if (!result.ok) {
          showToast(`❌ Estimation failed: ${result.error}`, 'error', 9000);
          addActivityLog(`Estimation failed: ${result.error}`, 'error');
          return;
        }

        estimationResults = result.data || [];
        expandedRows.clear();
        displayResults(estimationResults);

        showToast('✅ Estimation completed', 'success', 2000);
        addActivityLog(`Estimation completed: ${estimationResults.length} items`, 'success');

        const uploadBtn = $('uploadJiraBtn');
        if (uploadBtn) uploadBtn.style.display = estimateOnly ? 'none' : 'inline-block';
        return;
      }

      // SFD mode
      // Requires sfd API exposure
      if (!window.api?.sfd?.process) {
        enable($('processBtn'));
        showToast('❌ SFD mode not available (preload IPC missing: window.api.sfd.process)', 'error', 9000);
        addActivityLog('SFD estimation failed: preload IPC missing', 'error');
        return;
      }

      // Enforce compatible providers (your engine supports OpenAI/Azure)
      const pLower = String(selectedProvider).toLowerCase();
      if (pLower !== 'openai' && pLower !== 'azure') {
        enable($('processBtn'));
        showToast('❌ SFD estimation supports only OpenAI or Azure', 'error', 7000);
        addActivityLog('SFD estimation blocked: provider not supported', 'error');
        return;
      }

      const result = await window.api.sfd.process(uploadedFile.path, {
        provider: selectedProvider,
        config: providerConfig,
      });

      enable($('processBtn'));

      if (!result?.ok) {
        showToast(`❌ SFD estimation failed: ${result?.error || 'Unknown error'}`, 'error', 9000);
        addActivityLog(`SFD estimation failed: ${result?.error || 'Unknown error'}`, 'error');
        return;
      }

      const payload = result.data || {};
      estimationResults = payload.rows || [];
      expandedRows.clear();
      displayResults(estimationResults);

      showToast('✅ SFD estimation completed', 'success', 2500);
      addActivityLog(
        `SFD completed: ${payload.successfulActivities ?? 0}/${payload.totalActivities ?? 0} activities`,
        'success'
      );

      const uploadBtn = $('uploadJiraBtn');
      if (uploadBtn) uploadBtn.style.display = estimateOnly ? 'none' : 'inline-block';
    } catch (e) {
      enable($('processBtn'));
      showToast(`❌ Estimation failed: ${e.message}`, 'error', 9000);
      addActivityLog(`Estimation failed: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------
  // Results table rendering (supports both XLSX and SFD rows)
  // ---------------------------------------------------------
  function displayResults(results) {
    const tbody = $('resultsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    let completed = 0;
    let totalEffort = 0;

    (results || []).forEach((r, idx) => {
      const ok = Boolean(r?.ok);
      const status = ok ? '✅ Done' : `❌ ${r?.error || 'Failed'}`;

      if (ok) {
        completed += 1;
        totalEffort += Number(r.finalEffort ?? r.hours ?? 0);
      }

      const summary = r.summary || r.title || 'N/A';
      const crimType = r.crim_type || r.crim_type || r.category || 'N/A';
      const complexity = ok ? (r.complexity || 'N/A') : 'N/A';
      const total = ok ? Number(r.finalEffort ?? r.hours ?? 0) : NaN;

      const viewWbsBtn = ok
        ? `<button class="btn btn-mini btn-glass view-btn" data-action="view-wbs" data-idx="${idx}">View WBS</button>`
        : `<span class="muted">N/A</span>`;

      const viewReasonBtn = ok
        ? `<button class="btn btn-mini btn-glass view-btn" data-action="view-reason" data-idx="${idx}">View</button>`
        : `<span class="muted">N/A</span>`;

      const expandBtn = ok
        ? `<button class="btn btn-mini btn-outline expand-btn" data-idx="${idx}">${expandedRows.has(idx) ? '▲ Hide' : '▼ Expand'}</button>`
        : '';

      const tr = document.createElement('tr');
      tr.className = 'card-row';
      tr.innerHTML = `
        <td>${escapeHtml(summary)}</td>
        <td>${escapeHtml(crimType)}</td>
        <td><span class="badge">${escapeHtml(complexity)}</span></td>
        <td><span class="badge badge-strong">${ok ? total.toFixed(1) : 'N/A'}h</span></td>
        <td>${viewWbsBtn}</td>
        <td>${viewReasonBtn}</td>
        <td>${escapeHtml(status)} ${expandBtn}</td>
      `;
      tbody.appendChild(tr);

      if (expandedRows.has(idx)) {
        const exp = document.createElement('tr');
        exp.className = 'expand-row';
        exp.innerHTML = `
          <td colspan="7">
            <div class="expand-panel">
              <div class="expand-title">Quick Summary</div>
              <div class="expand-meta">
                <span class="pill">${escapeHtml(crimType)}</span>
                <span class="pill pill-soft">${escapeHtml(complexity)}</span>
                <span class="pill pill-strong">${ok ? total.toFixed(1) : 'N/A'}h</span>
              </div>
              <div class="expand-desc">${escapeHtml(r.description || '')}</div>
            </div>
          </td>
        `;
        tbody.appendChild(exp);
      }
    });

    const progressFill = $('progressFill');
    const progressText = $('progressText');
    const percent = results?.length ? (completed / results.length) * 100 : 0;

    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) {
      progressText.textContent = `Completed: ${completed}/${results.length} | Total Effort: ${totalEffort.toFixed(1)}h`;
    }
  }

  // ---------------------------------------------------------
  // Detail modal: WBS donut + legend + reasoning
  // ---------------------------------------------------------
  function buildDonutGradient(segments) {
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    let acc = 0;
    const stops = segments.map((s) => {
      const start = (acc / total) * 100;
      acc += s.value;
      const end = (acc / total) * 100;
      return `${s.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }

  function renderWbsDonutAndLegend(row) {
    const viz = $('detailViz');
    const donut = $('wbsDonut');
    const legend = $('wbsLegend');
    const donutTotal = $('donutTotal');
    if (!viz || !donut || !legend || !donutTotal) return;

    const wbs = row?.wbs || {};
    const entries = Object.entries(wbs)
      .map(([k, v]) => ({ label: k, value: Number(v || 0) }))
      .filter((x) => x.value > 0);

    if (!entries.length) {
      viz.style.display = 'none';
      return;
    }

    viz.style.display = 'grid';
    const palette = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#22c55e', '#38bdf8', '#a855f7'];
    const segments = entries.map((e, i) => ({ ...e, color: palette[i % palette.length] }));

    const total = segments.reduce((a, s) => a + s.value, 0);
    donut.style.background = buildDonutGradient(segments);
    donutTotal.textContent = `${total.toFixed(1)}h`;

    legend.innerHTML = segments.map((s) => {
      const pct = total > 0 ? (s.value / total) * 100 : 0;
      return `
        <div class="legend-item">
          <span class="dot" style="background:${s.color}"></span>
          <span class="legend-label">${escapeHtml(s.label)}</span>
          <span class="legend-val">${s.value.toFixed(1)}h</span>
          <span class="legend-pct">${pct.toFixed(0)}%</span>
        </div>
      `;
    }).join('');
  }

  function formatReasoning(reasoning) {
    const text = String(reasoning || '').trim();
    if (!text) return '<div class="empty-state">No reasoning returned by provider.</div>';
    return `<div class="reason-box">${escapeHtml(text)}</div>`;
  }

  function openDetailModal(kind, row) {
    const modal = $('detailModal');
    const title = $('detailModalTitle');
    const meta = $('detailModalMeta');
    const body = $('detailModalBody');

    if (!modal || !title || !meta || !body) {
      showToast('⚠️ Detail modal not found in index.html', 'warning', 4000);
      return;
    }

    modalActiveRow = row;
    modalActiveTab = (kind === 'reason') ? 'reason' : 'wbs';

    const summary = row?.summary || row?.title || 'Details';
    const crim = row?.crim_type || row?.category || 'N/A';
    const complexity = row?.complexity || 'N/A';
    const effort = Number(row?.finalEffort ?? row?.hours ?? 0);

    title.textContent = summary;
    meta.innerHTML = `
      <span class="pill">${escapeHtml(crim)}</span>
      <span class="pill pill-soft">${escapeHtml(complexity)}</span>
      <span class="pill pill-strong">${effort.toFixed(1)}h</span>
    `;

    const tabW = $('tabWbsBtn');
    const tabR = $('tabReasonBtn');
    if (tabW && tabR) {
      tabW.classList.toggle('active', modalActiveTab === 'wbs');
      tabR.classList.toggle('active', modalActiveTab === 'reason');
    }

    if (modalActiveTab === 'wbs') {
      body.innerHTML = '';
      renderWbsDonutAndLegend(row);
    } else {
      const viz = $('detailViz');
      if (viz) viz.style.display = 'none';
      body.innerHTML = formatReasoning(row?.reasoning);
    }

    modal.style.display = 'block';
    document.body.classList.add('modal-open');
  }

  function closeDetailModal() {
    const modal = $('detailModal');
    if (!modal) return;
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
    modalActiveRow = null;
  }

  // ---------------------------------------------------------
  // Exports
  // ---------------------------------------------------------
  function sanitizeFilename(name) {
    return String(name || 'export')
      .slice(0, 60)
      .replace(/[^a-z0-9\- _]/gi, '_')
      .trim() || 'export';
  }

  function downloadText(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toCsvRow(values) {
    return values.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',');
  }

  function wbsToCsv(row) {
    const wbs = row?.wbs || {};
    const header = toCsvRow(['Activity', 'Hours']);
    const lines = Object.entries(wbs).map(([k, v]) => toCsvRow([k, Number(v || 0).toFixed(1)]));
    return [header, ...lines].join('\n');
  }

  function resultsToCsv(rows) {
    const header = toCsvRow(['Summary', 'CRIM Type', 'Complexity', 'Total Effort (h)']);
    const lines = (rows || []).map((r) => toCsvRow([
      r.summary || r.title || '',
      r.crim_type || r.category || '',
      r.complexity || '',
      Number(r.finalEffort ?? r.hours ?? 0).toFixed(1),
    ]));
    return [header, ...lines].join('\n');
  }

  // ---------------------------------------------------------
  // Jira upload (mode-aware)
  // ---------------------------------------------------------
  function findSfdTotalRow(rows) {
    if (!Array.isArray(rows)) return null;
    return (
      rows.find((r) => r?.ok && r?.kind === 'sfd_total') ||
      rows.find((r) => r?.ok && String(r?.summary || '').toUpperCase().includes('TOTAL')) ||
      null
    );
  }

  async function uploadToJira() {
    if (!currentConfig.jira?.url) {
      showToast('❌ Jira configuration not found. Configure Jira in Settings.', 'error', 7000);
      return;
    }

    const projectKey = ($('jiraProjectSelect')?.value || '').trim();
    if (!projectKey) {
      showToast('❌ Please select a Jira project', 'error', 6000);
      return;
    }

    if (!estimationResults || estimationResults.length === 0) {
      showToast('❌ No estimation results available to upload', 'error', 6000);
      return;
    }

    currentMode = getModeFromUI();

    disable($('uploadJiraBtn'));
    showToast('📤 Uploading to Jira...', 'info', 2000);
    addActivityLog(`Uploading to ${projectKey} (${currentMode.toUpperCase()})`, 'info');

    try {
      let tickets = [];

      if (currentMode === 'xlsx') {
        // Bulk: one ticket per row
        tickets = (estimationResults || []).map((r) => {
          const totalHours = Number(r.finalEffort ?? r.hours ?? 0) || 0;
          return {
            summary: r.summary,
            description: r.description,
            issueType: 'Task',
            project: projectKey,

            // data used for comment formatting in jiraService
            wbs: r.wbs || {},
            aiReasoning: r.reasoning || '',
            complexity: r.complexity || 'N/A',
            direction: r.direction || 'N/A',
            flow: r.flow || 'N/A',
            totalHours,

            customFields: {
              c_crim_type: r.crim_type,
              timeestimate: Math.round(totalHours * 3600),
            },
          };
        });
      } else {
        // SFD: create ONE ticket from TOTAL row and attach DOCX
        const totalRow = findSfdTotalRow(estimationResults);
        if (!totalRow) {
          enable($('uploadJiraBtn'));
          showToast('❌ Could not find TOTAL row for SFD upload', 'error', 8000);
          addActivityLog('SFD upload failed: TOTAL row missing', 'error');
          return;
        }

        const totalHours = Number(totalRow.finalEffort ?? totalRow.hours ?? 0) || 0;
        const fileName = uploadedFile?.name || 'SFD.docx';

        tickets = [{
          summary: `SFD: ${fileName}`,
          description: `SFD effort estimation generated by EffortIQ.\n\nAttached: ${fileName}`,
          issueType: 'Task',
          project: projectKey,

          // Total WBS + reasoning goes to comment
          wbs: totalRow.wbs || {},
          aiReasoning: totalRow.reasoning || 'Aggregated SFD estimation total.',
          complexity: totalRow.complexity || 'N/A',
          direction: totalRow.direction || 'N/A',
          flow: totalRow.flow || 'N/A',
          totalHours,

          customFields: {
            // timeestimate seconds used by jiraService to update original estimate
            timeestimate: Math.round(totalHours * 3600),
          },

          // jiraService (updated) should upload attachments[] after creation
          attachments: uploadedFile?.path ? [uploadedFile.path] : [],
        }];
      }

      const res = await window.api.jira.createTickets(
        tickets,
        currentConfig.jira,
        { crimFieldName: 'C_CRIM_TYPE', failIfCrimFieldMissing: false }
      );

      enable($('uploadJiraBtn'));

      if (!res?.ok) {
        showToast(`❌ Jira upload failed: ${res?.error || 'Unknown error'}`, 'error', 9000);
        addActivityLog(`Jira upload failed: ${res?.error || 'Unknown error'}`, 'error');
        return;
      }

      const data = res.data;
      if (!data?.ok) {
        showToast(`❌ Jira upload failed: ${data?.error || 'Unknown error'}`, 'error', 9000);
        addActivityLog(`Jira upload failed: ${data?.error || 'Unknown error'}`, 'error');
        return;
      }

      const total = data.total ?? tickets.length;
      const created = data.created ?? 0;
      const results = data.results ?? [];

      const createdKeys = results.filter((r) => r.ok && r.key).map((r) => r.key);
      if (createdKeys.length > 0) showViewJiraTicketsButton(currentConfig.jira.url, createdKeys);

      if (created === 0 && total > 0) {
        const firstError = (results || []).find((x) => !x.ok)?.error || 'Unknown error';
        showToast(`⚠️ 0/${total} created. First error: ${firstError}`, 'warning', 9000);
        addActivityLog(`0/${total} created. First error: ${firstError}`, 'error');
      } else {
        showToast(`✅ Created ${created}/${total} ticket(s)`, 'success', 4000);
        addActivityLog(`Created ${created}/${total} Jira ticket(s)`, 'success');

        // Soft warning if attachment upload failed (only applies if jiraService supports it)
        const attachFail = results.find((r) => r.ok && r.attachmentsOk === false);
        if (attachFail) {
          showToast('⚠️ Ticket created but attachment upload failed (check Jira permissions / attachment API).', 'warning', 8000);
          addActivityLog('Attachment upload failed for at least one ticket', 'error');
        }
      }
    } catch (e) {
      enable($('uploadJiraBtn'));
      showToast(`❌ Jira upload failed: ${e.message}`, 'error', 9000);
      addActivityLog(`Jira upload failed: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------
  // Reset UI
  // ---------------------------------------------------------
  function resetProcessingUI(resetFile = true) {
    hide($('resultsCard'));
    hide($('previewCard'));
    hide($('optionsCard'));

    const resultsBody = $('resultsTableBody');
    if (resultsBody) resultsBody.innerHTML = '';

    expandedRows.clear();
    modalActiveRow = null;
    modalActiveTab = 'wbs';

    estimationResults = [];

    // Keep uploadedData only relevant for XLSX mode; clear on reset
    uploadedData = [];

    if (resetFile) {
      uploadedFile = null;
      setSelectedFileLabel('');
      if ($('fileInput')) $('fileInput').value = '';
    }

    if ($('uploadJiraBtn')) $('uploadJiraBtn').style.display = 'none';
    if ($('progressFill')) $('progressFill').style.width = '0%';
    if ($('progressText')) $('progressText').textContent = 'Processing: 0/0';
  }

  // ---------------------------------------------------------
  // Wire events
  // ---------------------------------------------------------
  function wireEvents() {
    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => showSection(item.dataset.section));
    });

    // Header settings
    $('settingsBtn')?.addEventListener('click', () => showSection('settings'));

    // Quick actions
    $('uploadExcelBtn')?.addEventListener('click', () => showSection('upload'));
    $('setupConfigBtn')?.addEventListener('click', () => showSection('settings'));

    // Settings provider switch
    $('providerType')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      currentConfig.provider = provider;
      showProviderConfig(provider);
      updateStatus();
    });

    // Save config
    $('saveConfigBtn')?.addEventListener('click', saveConfiguration);

    // Reset config (best-effort)
    $('resetConfigBtn')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all configuration?')) {
        currentConfig = {};
        updateStatus();
        setProjectSelectMessage('Select a project...');
        showToast('✅ Reset done', 'success', 2000);
      }
    });

    // Jira test
    $('testJiraBtn')?.addEventListener('click', async () => {
      const jiraConfig = {
        url: $('jiraUrl')?.value || '',
        email: $('jiraEmail')?.value || '',
        token: $('jiraToken')?.value || '',
      };
      const res = await window.api.jira.testConnection(jiraConfig);
      if (res.ok && res.data?.ok) {
        currentConfig.jira = jiraConfig;
        updateStatus();
        await fetchAndBindProjects(jiraConfig);
        showToast('✅ Jira connected', 'success', 2000);
        addActivityLog('Jira connection test successful', 'success');
      } else {
        const msg = res.error || res.data?.error || 'Connection failed';
        showToast(`❌ Jira connection failed: ${msg}`, 'error', 8000);
        addActivityLog(`Jira connection test failed: ${msg}`, 'error');
      }
    });

    // Refresh projects
    $('refreshProjectsBtn')?.addEventListener('click', async () => {
      await fetchAndBindProjects(currentConfig.jira);
      showToast('✅ Projects refreshed', 'success', 2000);
    });

    // Estimate-only disables dropdown + refresh
    $('estimateOnly')?.addEventListener('change', (e) => {
      const disabled = Boolean(e.target.checked);
      $('jiraProjectSelect') && ($('jiraProjectSelect').disabled = disabled);
      $('refreshProjectsBtn') && ($('refreshProjectsBtn').disabled = disabled);
    });

    // Optional mode selector
    $('estimationMode')?.addEventListener('change', (e) => {
      const m = String(e.target.value || '').toLowerCase();
      applyModeToUI(m === 'sfd' ? 'sfd' : 'xlsx');
    });

    // Process estimates
    $('processBtn')?.addEventListener('click', processEstimates);

    // Cancel/new
    $('cancelBtn')?.addEventListener('click', () => resetProcessingUI(true));
    $('newUploadBtn')?.addEventListener('click', () => resetProcessingUI(true));

    // Jira upload
    $('uploadJiraBtn')?.addEventListener('click', uploadToJira);

    // Browse button (supports both explicit #browseBtn or legacy inline)
    $('browseBtn')?.addEventListener('click', () => $('fileInput')?.click());

    // Dropzone + file input
    const dropzone = $('dropzone');
    const fileInput = $('fileInput');

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFileUpload(f);
    });

    fileInput?.addEventListener('change', (e) => {
      const f = e.target?.files?.[0];
      if (f) handleFileUpload(f);
    });

    // Results table: view buttons + expand (event delegation)
    $('resultsTableBody')?.addEventListener('click', (e) => {
      const viewBtn = e.target?.closest?.('.view-btn');
      if (viewBtn) {
        const action = viewBtn.dataset.action;
        const idx = Number(viewBtn.dataset.idx);
        const row = (estimationResults || [])[idx];
        if (!row) return;
        if (action === 'view-wbs') openDetailModal('wbs', row);
        if (action === 'view-reason') openDetailModal('reason', row);
        return;
      }

      const expandBtn = e.target?.closest?.('.expand-btn');
      if (expandBtn) {
        const idx = Number(expandBtn.dataset.idx);
        if (expandedRows.has(idx)) expandedRows.delete(idx);
        else expandedRows.add(idx);
        displayResults(estimationResults);
      }
    });

    // Modal controls (optional)
    $('detailModalCloseBtn')?.addEventListener('click', closeDetailModal);
    $('detailModalCloseBtn2')?.addEventListener('click', closeDetailModal);
    $('detailModal')?.addEventListener('click', (e) => {
      if (e.target?.id === 'detailModal') closeDetailModal();
    });

    $('tabWbsBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      openDetailModal('wbs', modalActiveRow);
    });

    $('tabReasonBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      openDetailModal('reason', modalActiveRow);
    });

    $('copyDetailsBtn')?.addEventListener('click', async () => {
      if (!modalActiveRow) return;
      const text = (modalActiveTab === 'wbs')
        ? JSON.stringify(modalActiveRow.wbs || {}, null, 2)
        : String(modalActiveRow.reasoning || '');
      try {
        await navigator.clipboard.writeText(text);
        showToast('✅ Copied to clipboard', 'success', 1500);
      } catch {
        showToast('⚠️ Copy failed (clipboard not available)', 'warning', 2500);
      }
    });

    // Export: modal buttons
    $('exportWbsCsvBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || modalActiveRow.title || 'WBS');
      downloadText(`${name}-WBS.csv`, wbsToCsv(modalActiveRow), 'text/csv');
      showToast('✅ WBS CSV exported', 'success', 1500);
    });

    $('exportReasonTxtBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || modalActiveRow.title || 'Reasoning');
      downloadText(`${name}-Reasoning.txt`, String(modalActiveRow.reasoning || ''), 'text/plain');
      showToast('✅ Reasoning exported', 'success', 1500);
    });

    $('exportRowJsonBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || modalActiveRow.title || 'Row');
      downloadText(`${name}.json`, JSON.stringify(modalActiveRow, null, 2), 'application/json');
      showToast('✅ Row JSON exported', 'success', 1500);
    });

    // Export all
    $('exportAllJsonBtn')?.addEventListener('click', () => {
      downloadText('EffortIQ-Results.json', JSON.stringify(estimationResults || [], null, 2), 'application/json');
      showToast('✅ Exported all results (JSON)', 'success', 2000);
    });

    $('exportAllCsvBtn')?.addEventListener('click', () => {
      downloadText('EffortIQ-Results.csv', resultsToCsv(estimationResults || []), 'text/csv');
      showToast('✅ Exported all results (CSV)', 'success', 2000);
    });

    // ESC closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetailModal();
    });
  }

  // ---------------------------------------------------------
  // Boot
  // ---------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      wireEvents();
      updateStatus();

      const apiReady = await waitForAPI(8000);
      if (!apiReady) {
        console.error('[EffortIQ] window.api not available – running UI in degraded mode');
        showToast('⚠️ Backend not connected. UI loaded in degraded mode.', 'warning', 8000);
        addActivityLog('Backend API not available (preload/IPC issue). Limited functionality.', 'error');
        // Do not return: allow UI to load anyway
      }

      bindLiveProgressOnce();
      await loadConfiguration();

      // Initialize mode from UI if present
      applyModeToUI(getModeFromUI());

      showToast('👋 Welcome to EffortIQ!', 'info', 1500);
      addActivityLog('Application started', 'info');
    } catch (e) {
      errorLog('Renderer boot failed:', e);
      showToast(`❌ UI boot failed: ${e.message}`, 'error', 9000);
    }
  });
})();