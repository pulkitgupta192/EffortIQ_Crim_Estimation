// ============================================
// EffortIQ - Renderer Process (UI Logic)
// - XLSX High Level Estimation (unchanged)
// - SFD: Dev Effort per activity (no per-activity WBS) + single WBS on FINAL row
// ============================================
(() => {
  'use strict';
  console.log('[EffortIQ] Renderer loaded');

  const DEBUG = localStorage.getItem('effortiq:debug') === '1';
  const log = (...args) => DEBUG && console.log('[EffortIQ]', ...args);
  const warn = (...args) => DEBUG && console.warn('[EffortIQ]', ...args);
  const errorLog = (...args) => console.error('[EffortIQ]', ...args);

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
      .replace(/'/g, '&#039;');
  }

  let currentConfig = {};
  let uploadedData = [];
  let previewVirtual = null;
  let estimationResults = [];
  const expandedRows = new Set();

  let currentMode = 'xlsx';
  let uploadedFile = null;

  let modalActiveRow = null;
  let modalActiveTab = 'wbs';

  let progressSubscribed = false;

  function showToast(message, type = 'info', duration = 3000) {
    const toast = $('toast');
    if (!toast) { alert(message); return; }
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
    while (logContainer.children.length > 10) logContainer.removeChild(logContainer.lastChild);
  }

  function showSection(sectionId) {
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    const section = $(`section-${sectionId}`);
    if (section) section.classList.add('active');
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.remove('active');
      if (item.dataset.section === sectionId) item.classList.add('active');
    });
  }

  function updateStatus() {
    const configStatus = $('configStatus');
    const jiraStatus = $('jiraStatus');
    const providerStatus = $('providerStatus');

    if (providerStatus) {
      providerStatus.textContent = currentConfig.provider
        ? `✅ ${String(currentConfig.provider).toUpperCase()}`
        : '❌ Not Configured';
    }
    if (jiraStatus) jiraStatus.textContent = currentConfig.jira?.url ? '✅ Configured' : '❌ Not Connected';
    if (configStatus) configStatus.textContent = Object.keys(currentConfig).length ? '✅ Configured' : '❌ Not Set';
  }

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
        typeof api.sfd?.process === 'function' &&
        typeof api.jira?.testConnection === 'function' &&
        typeof api.jira?.listProjects === 'function' &&
        typeof api.jira?.createTickets === 'function'
      ) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  function showProviderConfig(provider) {
    document.querySelectorAll('.provider-config').forEach((node) => {
      node.classList.remove('active');
      node.style.display = 'none';
    });
    const active = $(`${provider}-config`);
    if (active) { active.classList.add('active'); active.style.display = 'block'; }
  }

  function buildJiraTicketsUrl(jiraBaseUrl, issueKeys = []) {
    const base = String(jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base || !issueKeys.length) return null;
    const keys = issueKeys.filter(Boolean).join(',');
    const jql = `key in (${keys})`;
    return `${base}/issues/?jql=${encodeURIComponent(jql)}`;
  }

  function showViewJiraTicketsButton(jiraUrl, issueKeys) {
    const container = document.getElementById('uploadJiraBtn')?.parentElement;
    if (!container) return;
    document.getElementById('viewJiraTicketsBtn')?.remove();
    const url = buildJiraTicketsUrl(jiraUrl, issueKeys);
    if (!url) return;

    const btn = document.createElement('button');
    btn.id = 'viewJiraTicketsBtn';
    btn.className = 'btn btn-outline';
    btn.type = 'button';
    btn.textContent = `🔗 View Jira Tickets (${issueKeys.length})`;
    btn.addEventListener('click', async () => {
      const res = await window.api?.shell?.openExternal?.(url);
      if (!res?.ok) showToast(`❌ Failed to open Jira: ${res?.error || 'Unknown error'}`, 'error', 7000);
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

  async function saveConfiguration() {
    const provider = $('providerType')?.value || 'openai';
    const cfg = { provider };

    if (provider === 'openai') cfg.openai = { apiKey: $('openaiKey')?.value || '', model: $('openaiModel')?.value || 'gpt-4o-mini' };
    else if (provider === 'azure') cfg.azure = {
      endpoint: $('azureEndpoint')?.value || '',
      apiKey: $('azureKey')?.value || '',
      deployment: $('azureDeployment')?.value || '',
      apiVersion: $('azureApiVersion')?.value || '2024-06-01',
    };
    else if (provider === 'gemini') cfg.gemini = { apiKey: $('geminiKey')?.value || '', model: $('geminiModel')?.value || 'gemini-1.5-pro' };
    else if (provider === 'local') cfg.local = { endpoint: $('localEndpoint')?.value || '' };

    cfg.jira = { url: $('jiraUrl')?.value || '', email: $('jiraEmail')?.value || '', token: $('jiraToken')?.value || '' };

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
  }

  async function loadConfiguration() {
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
    if (currentConfig.local) $('localEndpoint') && ($('localEndpoint').value = currentConfig.local.endpoint || '');
    if (currentConfig.jira) {
      $('jiraUrl') && ($('jiraUrl').value = currentConfig.jira.url || '');
      $('jiraEmail') && ($('jiraEmail').value = currentConfig.jira.email || '');
      $('jiraToken') && ($('jiraToken').value = currentConfig.jira.token || '');
    }

    updateStatus();
    if (currentConfig.jira?.url) await fetchAndBindProjects(currentConfig.jira);
  }

  function getModeFromUI() {
    const m = $('estimationMode')?.value;
    if (!m) return currentMode || 'xlsx';
    return (String(m).toLowerCase() === 'sfd') ? 'sfd' : 'xlsx';
  }

  function applyModeToUI(mode) {
    currentMode = (mode === 'sfd') ? 'sfd' : 'xlsx';
    const fileInput = $('fileInput');
    const dropzoneText = $('dropzoneText');
    const dropzoneIcon = $('dropzoneIcon');
    const sfdNote = $('sfdProviderNote');

    uploadedFile = null;
    uploadedData = [];
    if (fileInput) fileInput.value = '';

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

    resetProcessingUI(false);
  }

  function setSelectedFileLabel(text) {
    const label = $('selectedFileLabel');
    if (!label) return;
    if (!text) { label.style.display = 'none'; label.textContent = ''; return; }
    label.style.display = 'block';
    label.textContent = text;
  }

  function displayPreview(data) {
    const previewCard = $('previewCard');
    const optionsCard = $('optionsCard');

    if (currentMode !== 'xlsx') {
      hide(previewCard);
      show(optionsCard);
      return;
    }

    show(previewCard);
    show(optionsCard);

    if (previewVirtual && typeof previewVirtual.destroy === 'function') previewVirtual.destroy();

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

  function createVirtualizedPreview({ data, wrapper, tbody, countLabel, rowHeight = 56, overscan = 10 }) {
    if (!wrapper || !tbody) return { render: () => {}, destroy: () => {} };
    wrapper.classList.add('preview-virtual');

    let lastStart = -1;
    let ticking = false;

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
      if (total === 0) { countLabel.textContent = 'No rows found in the file.'; return; }
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

      if (start === lastStart && tbody.childNodes.length > 0) { setCountLabel(start, end, total); return; }
      lastStart = start;

      topSpacerTd.style.height = `${start * rowHeight}px`;
      bottomSpacerTd.style.height = `${(total - end) * rowHeight}px`;

      const frag = document.createDocumentFragment();
      frag.appendChild(topSpacerTr);

      for (let i = start; i < end; i++) {
        const row = data[i] || {};
        const tr = document.createElement('tr');
        tr.className = 'preview-row';
        const summary = escapeHtml(row.summary || '');
        const crim = escapeHtml(row.crim_type || '');
        const desc = escapeHtml(String(row.description || '').replace(/\r?\n/g, ' '));
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
      requestAnimationFrame(() => { ticking = false; render(); });
    }

    const ro = new ResizeObserver(() => render());
    ro.observe(wrapper);
    wrapper.addEventListener('scroll', onScroll, { passive: true });

    return { render, destroy: () => { wrapper.removeEventListener('scroll', onScroll); ro.disconnect(); } };
  }

  async function handleFileUpload(file) {
    if (!file) return;

    currentMode = getModeFromUI();
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
    } else {
      if (!file.name.toLowerCase().endsWith('.docx')) {
        showToast('❌ Please upload an SFD DOCX file (.docx)', 'error', 6000);
        addActivityLog('Invalid file selected (expected DOCX)', 'error');
        return;
      }
      hide($('previewCard'));
      show($('optionsCard'));
      showToast('✅ SFD DOCX selected. Ready to estimate.', 'success', 2500);
      addActivityLog(`SFD selected: ${file.name}`, 'success');
    }
  }

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

  async function processEstimates() {
    currentMode = getModeFromUI();
    const selectedProvider = $('aiProvider')?.value || currentConfig.provider;

    if (!selectedProvider) { showToast('❌ Configure AI provider first (Settings)', 'error', 7000); return; }
    if (!uploadedFile?.path) { showToast('❌ Upload a file first', 'error', 6000); return; }

    const estimateOnly = Boolean($('estimateOnly')?.checked);
    const projectKey = ($('jiraProjectSelect')?.value || '').trim();
    if (!estimateOnly && !projectKey) { showToast('❌ Select a Jira project', 'error', 6000); return; }

    show($('resultsCard'));
    disable($('processBtn'));
    hide($('uploadJiraBtn'));

    showToast('⚡ Processing estimates...', 'info', 2000);
    addActivityLog(`Estimating (${currentMode.toUpperCase()})`, 'info');

    const providerConfig = currentConfig[selectedProvider] || {};

    try {
      if (currentMode === 'xlsx') {
        if (!uploadedData?.length) { enable($('processBtn')); showToast('❌ No Excel rows to process', 'error', 6000); return; }

        const result = await window.api.estimate.process(uploadedData, {
          provider: selectedProvider,
          config: providerConfig,
          estimateOnly,
        });

        enable($('processBtn'));

        if (!result.ok) { showToast(`❌ Estimation failed: ${result.error}`, 'error', 9000); return; }

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
      const pLower = String(selectedProvider).toLowerCase();
      if (pLower !== 'openai' && pLower !== 'azure') {
        enable($('processBtn'));
        showToast('❌ SFD supports only OpenAI or Azure', 'error', 7000);
        return;
      }

      const result = await window.api.sfd.process(uploadedFile.path, { provider: selectedProvider, config: providerConfig });
      enable($('processBtn'));

      if (!result?.ok) { showToast(`❌ SFD estimation failed: ${result?.error || 'Unknown error'}`, 'error', 9000); return; }

      const payload = result.data || {};
      estimationResults = payload.rows || [];
      expandedRows.clear();
      displayResults(estimationResults);

      showToast('✅ SFD estimation completed', 'success', 2500);
      addActivityLog(`SFD completed: ${payload.successfulActivities ?? 0}/${payload.totalActivities ?? 0} activities`, 'success');

      const uploadBtn = $('uploadJiraBtn');
      if (uploadBtn) uploadBtn.style.display = estimateOnly ? 'none' : 'inline-block';
    } catch (e) {
      enable($('processBtn'));
      showToast(`❌ Estimation failed: ${e.message}`, 'error', 9000);
    }
  }

  function isSfdActivityRow(row) { return currentMode === 'sfd' && row?.kind === 'sfd_activity'; }
  function isSfdFinalRow(row) { return currentMode === 'sfd' && row?.kind === 'sfd_final'; }

  function getDisplayedEffortHours(row) {
    // XLSX unchanged: show final
    if (currentMode !== 'sfd') return Number(row?.finalEffort ?? row?.hours ?? 0);

    // SFD:
    if (row?.kind === 'sfd_activity') return Number(row?.devEffortHours ?? 0);
    if (row?.kind === 'sfd_total_dev') return Number(row?.devEffortHours ?? row?.hours ?? 0);

    // FINAL row shows Total Effort
    return Number(row?.finalEffort ?? row?.hours ?? 0);
  }

  function setEffortHeaderLabel() {
    const ths = document.querySelectorAll('#resultsTable thead th');
    if (!ths || ths.length < 4) return;
    ths[3].textContent = (currentMode === 'sfd') ? 'Effort (h)' : 'Total Effort (h)';
  }

  function displayResults(results) {
    const tbody = $('resultsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    setEffortHeaderLabel();

    let completed = 0;
    let effortShown = 0;

    (results || []).forEach((r, idx) => {
      const ok = Boolean(r?.ok);
      const status = ok ? '✅ Done' : `❌ ${r?.error || 'Failed'}`;

      if (ok) { completed += 1; effortShown += getDisplayedEffortHours(r); }

      const summary = r.summary || r.title || 'N/A';
      const crimType = r.crim_type || r.category || 'N/A';
      const complexity = ok ? (r.complexity || 'N/A') : 'N/A';
      const effort = ok ? getDisplayedEffortHours(r) : NaN;

      // WBS button rules:
      // - XLSX: show as before
      // - SFD: only FINAL row has WBS
      let viewWbsCell = '<span class="muted">N/A</span>';
      if (ok && currentMode !== 'sfd') {
        viewWbsCell = `<button class="btn btn-mini btn-glass view-btn" data-action="view-wbs" data-idx="${idx}">View WBS</button>`;
      } else if (ok && isSfdFinalRow(r)) {
        viewWbsCell = `<button class="btn btn-mini btn-glass view-btn" data-action="view-wbs" data-idx="${idx}">View WBS</button>`;
      }

      const viewReasonCell = ok
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
        <td><span class="badge badge-strong">${ok ? effort.toFixed(1) : 'N/A'}h</span></td>
        <td>${viewWbsCell}</td>
        <td>${viewReasonCell}</td>
        <td>${escapeHtml(status)} ${expandBtn}</td>
      `;
      tbody.appendChild(tr);

      if (expandedRows.has(idx)) {
        const direction = r?.direction ? `Direction: ${r.direction}` : '';
        const flow = r?.flow ? `Flow: ${r.flow}` : '';
        const extra = (direction || flow) ? `\n${direction}\n${flow}` : '';

        const exp = document.createElement('tr');
        exp.className = 'expand-row';
        exp.innerHTML = `
          <td colspan="7">
            <div class="expand-panel">
              <div class="expand-title">Quick Summary</div>
              <div class="expand-meta">
                <span class="pill">${escapeHtml(crimType)}</span>
                <span class="pill pill-soft">${escapeHtml(complexity)}</span>
                <span class="pill pill-strong">${ok ? effort.toFixed(1) : 'N/A'}h</span>
              </div>
              <div class="expand-desc">${escapeHtml((r.description || '') + extra)}</div>
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
    if (progressText) progressText.textContent = `Completed: ${completed}/${results.length} • Effort shown: ${effortShown.toFixed(1)}h`;
  }

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

    if (!entries.length) { viz.style.display = 'none'; return; }

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
    const effort = getDisplayedEffortHours(row);

    const dir = row?.direction ? `<span class="pill">${escapeHtml(row.direction)}</span>` : '';
    const flw = row?.flow ? `<span class="pill">${escapeHtml(row.flow)}</span>` : '';

    title.textContent = summary;
    meta.innerHTML = `
      <span class="pill">${escapeHtml(crim)}</span>
      <span class="pill pill-soft">${escapeHtml(complexity)}</span>
      <span class="pill pill-strong">${Number(effort || 0).toFixed(1)}h</span>
      ${dir}
      ${flw}
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

  function findSfdFinalRow(rows) {
    return (rows || []).find((r) => r?.ok && r?.kind === 'sfd_final') || null;
  }

  async function uploadToJira() {
    if (!currentConfig.jira?.url) { showToast('❌ Configure Jira in Settings', 'error', 7000); return; }

    const projectKey = ($('jiraProjectSelect')?.value || '').trim();
    if (!projectKey) { showToast('❌ Select a Jira project', 'error', 6000); return; }

    if (!estimationResults?.length) { showToast('❌ No estimation results to upload', 'error', 6000); return; }

    currentMode = getModeFromUI();
    disable($('uploadJiraBtn'));
    showToast('📤 Uploading to Jira...', 'info', 2000);
    addActivityLog(`Uploading to ${projectKey} (${currentMode.toUpperCase()})`, 'info');

    try {
      let tickets = [];

      if (currentMode === 'xlsx') {
        // XLSX unchanged
        tickets = (estimationResults || []).map((r) => {
          const totalHours = Number(r.finalEffort ?? r.hours ?? 0) || 0;
          return {
            summary: r.summary,
            description: r.description,
            issueType: 'Task',
            project: projectKey,
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
        // SFD: create ONE ticket from FINAL row and attach DOCX
        const finalRow = findSfdFinalRow(estimationResults);
        if (!finalRow) {
          enable($('uploadJiraBtn'));
          showToast('❌ SFD FINAL row not found', 'error', 8000);
          return;
        }

        const totalHours = Number(finalRow.finalEffort ?? finalRow.hours ?? 0) || 0;
        const fileName = uploadedFile?.name || 'SFD.docx';

        tickets = [{
          summary: `SFD: ${fileName}`,
          description: `SFD effort estimation generated by EffortIQ.\n\nAttached: ${fileName}`,
          issueType: 'Task',
          project: projectKey,

          // For comment builder (Jira service will detect sfdActivities)
          sfdActivities: finalRow.sfdActivities || [],
          wbs: finalRow.wbs || {},
          aiReasoning: finalRow.reasoning || '',
          complexity: finalRow.complexity || 'N/A',
          direction: finalRow.direction || 'N/A',
          flow: finalRow.flow || 'N/A',

          totalHours,
          customFields: {
            timeestimate: Math.round(totalHours * 3600),
          },

          attachments: uploadedFile?.path ? [uploadedFile.path] : [],
        }];
      }

      const res = await window.api.jira.createTickets(
        tickets,
        currentConfig.jira,
        { crimFieldName: 'C_CRIM_TYPE', failIfCrimFieldMissing: false }
      );

      enable($('uploadJiraBtn'));

      if (!res?.ok) { showToast(`❌ Jira upload failed: ${res?.error || 'Unknown error'}`, 'error', 9000); return; }
      const data = res.data;
      if (!data?.ok) { showToast(`❌ Jira upload failed: ${data?.error || 'Unknown error'}`, 'error', 9000); return; }

      const results = data.results || [];
      const createdKeys = results.filter((r) => r.ok && r.key).map((r) => r.key);
      if (createdKeys.length) showViewJiraTicketsButton(currentConfig.jira.url, createdKeys);

      showToast(`✅ Created ${data.created ?? 0}/${data.total ?? tickets.length} ticket(s)`, 'success', 4000);
      addActivityLog(`Created ${data.created ?? 0}/${data.total ?? tickets.length} Jira ticket(s)`, 'success');
    } catch (e) {
      enable($('uploadJiraBtn'));
      showToast(`❌ Jira upload failed: ${e.message}`, 'error', 9000);
    }
  }

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

  function wireEvents() {
    document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => showSection(item.dataset.section)));
    $('settingsBtn')?.addEventListener('click', () => showSection('settings'));
    $('uploadExcelBtn')?.addEventListener('click', () => showSection('upload'));
    $('setupConfigBtn')?.addEventListener('click', () => showSection('settings'));

    $('providerType')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      currentConfig.provider = provider;
      showProviderConfig(provider);
      updateStatus();
    });

    $('saveConfigBtn')?.addEventListener('click', saveConfiguration);

    $('testJiraBtn')?.addEventListener('click', async () => {
      const jiraConfig = { url: $('jiraUrl')?.value || '', email: $('jiraEmail')?.value || '', token: $('jiraToken')?.value || '' };
      const res = await window.api.jira.testConnection(jiraConfig);
      if (res.ok && res.data?.ok) {
        currentConfig.jira = jiraConfig;
        updateStatus();
        await fetchAndBindProjects(jiraConfig);
        showToast('✅ Jira connected', 'success', 2000);
      } else {
        showToast(`❌ Jira connection failed: ${res.error || res.data?.error || 'Connection failed'}`, 'error', 8000);
      }
    });

    $('refreshProjectsBtn')?.addEventListener('click', async () => {
      await fetchAndBindProjects(currentConfig.jira);
      showToast('✅ Projects refreshed', 'success', 2000);
    });

    $('estimateOnly')?.addEventListener('change', (e) => {
      const disabled = Boolean(e.target.checked);
      $('jiraProjectSelect') && ($('jiraProjectSelect').disabled = disabled);
      $('refreshProjectsBtn') && ($('refreshProjectsBtn').disabled = disabled);
    });

    $('estimationMode')?.addEventListener('change', (e) => applyModeToUI(String(e.target.value || '').toLowerCase() === 'sfd' ? 'sfd' : 'xlsx'));
    $('processBtn')?.addEventListener('click', processEstimates);

    $('cancelBtn')?.addEventListener('click', () => resetProcessingUI(true));
    $('newUploadBtn')?.addEventListener('click', () => resetProcessingUI(true));
    $('uploadJiraBtn')?.addEventListener('click', uploadToJira);

    $('browseBtn')?.addEventListener('click', () => $('fileInput')?.click());

    const dropzone = $('dropzone');
    const fileInput = $('fileInput');

    dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
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

    $('detailModalCloseBtn')?.addEventListener('click', closeDetailModal);
    $('detailModalCloseBtn2')?.addEventListener('click', closeDetailModal);

    $('detailModal')?.addEventListener('click', (e) => { if (e.target?.id === 'detailModal') closeDetailModal(); });
    $('tabWbsBtn')?.addEventListener('click', () => modalActiveRow && openDetailModal('wbs', modalActiveRow));
    $('tabReasonBtn')?.addEventListener('click', () => modalActiveRow && openDetailModal('reason', modalActiveRow));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      wireEvents();
      updateStatus();
      const apiReady = await waitForAPI(8000);
      if (!apiReady) showToast('⚠️ Backend not connected. UI in degraded mode.', 'warning', 8000);
      bindLiveProgressOnce();
      await loadConfiguration();
      applyModeToUI(getModeFromUI());
      showToast('👋 Welcome to EffortIQ!', 'info', 1500);
      addActivityLog('Application started', 'info');
    } catch (e) {
      errorLog('Renderer boot failed:', e);
      showToast(`❌ UI boot failed: ${e.message}`, 'error', 9000);
    }
  });
})();