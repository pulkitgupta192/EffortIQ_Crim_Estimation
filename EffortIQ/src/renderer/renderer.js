// ============================================
// EffortIQ - Renderer Process (REBUILT FROM ATTACHED SOURCE)
// ============================================
// What this rebuild preserves (from your attached renderer.js + styles.css):
// - CRIM flow: Excel upload → preview → AI estimate → results → exports → Jira upload
// - SFD flow: native browse/parse → extract → preview filters/ignore → classify → estimate
// - PowerBI-style UI contract: IDs/classes used by index.html + styles.css
// - Shared modal: WBS + AI Reasoning tabs
//
// What this rebuild fixes:
// - Broken escapeHtml and malformed JS blocks in the attached file
// - Duplicate/conflicting SFD browse handlers
// - Preview filter state bugs
// - Safer, deterministic event wiring
//
// IMPORTANT:
// - This file assumes preload exposes window.api.* (excel/config/estimate/jira/shell/sfd)
// - This file does NOT change your styles.css; it uses your existing classes
// ============================================

(() => {
  'use strict';

  // ---------------------------------------------------------
  // Debug toggle
  // Enable:  localStorage.setItem('effortiq:debug','1'); location.reload();
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

  // ---------------------------------------------------------
  // Safe HTML
  // ---------------------------------------------------------
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
  // Toast + Activity Log
  // ---------------------------------------------------------
  function showToast(message, type = 'info', duration = 3000) {
    const toast = $('toast');
    if (!toast) {
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
  // Download helpers
  // ---------------------------------------------------------
  function sanitizeFilename(name) {
    return String(name ?? 'export')
      .slice(0, 80)
      .replace(/[^a-z0-9\-_ ]/gi, '_')
      .trim() || 'export';
  }

  function downloadText(filename, text, mime = 'text/plain') {
    const blob = new Blob([String(text ?? '')], { type: mime });
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
    return (values || []).map(v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',');
  }

  // ---------------------------------------------------------
  // Global State (CRIM)
  // ---------------------------------------------------------
  let currentConfig = {};
  let uploadedData = [];
  let previewVirtual = null;
  let estimationResults = [];
  const expandedRows = new Set();

  // Modal state
  let modalActiveRow = null;
  let modalActiveTab = 'wbs';

  // ---------------------------------------------------------
  // Global State (SFD)
  // ---------------------------------------------------------
  let sfdFile = null;             // { name, path }
  let sfdParsed = null;           // { text, meta }
  let sfdActivities = [];
  let sfdClassified = [];
  let sfdEstimated = null;

  // Preview filter + ignore (SFD)
  let sfdPreviewFilters = {
    query: '',
    minConfidence: 0.55,
    subtype: 'ALL',
    showAcceptance: true,
    showIgnored: false,
  };
  let sfdIgnoredActivities = new Set();

  // ---------------------------------------------------------
  // API readiness
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
        typeof api.jira?.createTickets === 'function' &&
        typeof api.shell?.openExternal === 'function' &&
        typeof api.sfd?.parse === 'function' &&
        typeof api.sfd?.extract === 'function' &&
        typeof api.sfd?.classify === 'function' &&
        typeof api.sfd?.estimate === 'function'
      ) {
        return true;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }

  // ---------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------
  function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const section = $(`section-${sectionId}`);
    if (section) section.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(item => {
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
      configStatus.textContent = Object.keys(currentConfig || {}).length ? '✅ Configured' : '❌ Not Set';
    }
  }

  // ---------------------------------------------------------
  // Provider config panel switch
  // ---------------------------------------------------------
  function showProviderConfig(provider) {
    document.querySelectorAll('.provider-config').forEach(node => {
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
  // Shell openExternal
  // ---------------------------------------------------------
  async function openExternal(url) {
    if (!window.api?.shell?.openExternal) {
      return { ok: false, error: 'shell.openExternal not available' };
    }
    return window.api.shell.openExternal(url);
  }

  // ---------------------------------------------------------
  // Jira projects dropdown
  // ---------------------------------------------------------
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

    (projects || []).forEach(p => {
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
      return;
    }

    const data = res.data;
    if (!data?.ok) {
      setProjectSelectMessage('Failed to load projects');
      showToast(`❌ Failed to load Jira projects: ${data?.error || 'Unknown error'}`, 'error', 7000);
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
        model: $('openaiModel')?.value || 'gpt-4o-mini'
      };
    } else if (provider === 'azure') {
      cfg.azure = {
        endpoint: $('azureEndpoint')?.value || '',
        apiKey: $('azureKey')?.value || '',
        deployment: $('azureDeployment')?.value || '',
        apiVersion: $('azureApiVersion')?.value || '2024-06-01'
      };
    } else if (provider === 'gemini') {
      cfg.gemini = {
        apiKey: $('geminiKey')?.value || '',
        model: $('geminiModel')?.value || 'gemini-1.5-pro'
      };
    } else if (provider === 'local') {
      cfg.local = {
        endpoint: $('localEndpoint')?.value || ''
      };
    }

    cfg.jira = {
      url: $('jiraUrl')?.value || '',
      email: $('jiraEmail')?.value || '',
      token: $('jiraToken')?.value || ''
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
      }
    } catch (e) {
      showToast(`❌ Save failed: ${e.message}`, 'error', 7000);
    }
  }

  async function loadConfiguration() {
    try {
      const result = await window.api.config.load();
      if (!result.ok || !result.data) return;

      currentConfig = result.data || {};

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
      if (currentConfig.jira?.url) {
        await fetchAndBindProjects(currentConfig.jira);
      }
    } catch (e) {
      warn('Load config failed:', e);
    }
  }

  // ---------------------------------------------------------
  // CRIM: Reset UI
  // ---------------------------------------------------------
  function resetCrimUI() {
    hide($('resultsCard'));
    hide($('previewCard'));
    hide($('optionsCard'));

    const resultsBody = $('resultsTableBody');
    if (resultsBody) resultsBody.innerHTML = '';

    uploadedData = [];
    estimationResults = [];
    expandedRows.clear();

    if ($('fileInput')) $('fileInput').value = '';
    if ($('uploadJiraBtn')) $('uploadJiraBtn').style.display = 'none';

    const viewBtn = $('viewJiraTicketsBtn');
    if (viewBtn) viewBtn.remove();

    if ($('progressFill')) $('progressFill').style.width = '0%';
    if ($('progressText')) $('progressText').textContent = 'Processing: 0/0';
  }

  // ---------------------------------------------------------
  // CRIM: Virtualized preview
  // ---------------------------------------------------------
  function createVirtualizedPreview({ data, wrapper, tbody, countLabel, rowHeight = 56, overscan = 10 }) {
    if (!wrapper || !tbody) return { render: () => {}, destroy: () => {} };

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
      }
    };
  }

  function displayPreview(data) {
    hide($('resultsCard'));
    show($('previewCard'));
    show($('optionsCard'));

    if (previewVirtual && typeof previewVirtual.destroy === 'function') {
      previewVirtual.destroy();
    }

    const wrapper = $('previewTableWrapper') || $('previewTable')?.closest('.table-wrapper');

    previewVirtual = createVirtualizedPreview({
      data: Array.isArray(data) ? data : [],
      wrapper,
      tbody: $('previewTableBody'),
      countLabel: $('previewCount'),
      rowHeight: 56,
      overscan: 10
    });

    previewVirtual.render();
  }

  async function handleExcelFile(file) {
    if (!file) return;

    resetCrimUI();

    const name = String(file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      showToast('❌ Please upload an Excel file (.xlsx or .xls)', 'error', 6000);
      return;
    }

    showToast('📂 Reading Excel file...', 'info', 1500);
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
      showToast(`✅ Loaded ${uploadedData.length} rows`, 'success', 2000);
      addActivityLog(`Loaded ${uploadedData.length} rows`, 'success');
    } catch (e) {
      showToast(`❌ Excel parse failed: ${e.message}`, 'error', 8000);
      addActivityLog(`Excel parse failed: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------
  // CRIM: Live progress
  // ---------------------------------------------------------
  function bindLiveProgress() {
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
  }

  // ---------------------------------------------------------
  // CRIM: Process estimates
  // ---------------------------------------------------------
  async function processCrimEstimates() {
    const selectedProvider = $('aiProvider')?.value || currentConfig.provider;
    if (!selectedProvider) {
      showToast('❌ Please configure an AI provider first (Settings)', 'error', 7000);
      return;
    }

    if (!uploadedData || uploadedData.length === 0) {
      showToast('❌ No data to process', 'error', 6000);
      return;
    }

    const estimateOnly = Boolean($('estimateOnly')?.checked);
    const projectKey = String($('jiraProjectSelect')?.value || '').trim();
    if (!estimateOnly && !projectKey) {
      showToast('❌ Please select a Jira project', 'error', 6000);
      return;
    }

    show($('resultsCard'));
    disable($('processBtn'));

    if ($('progressFill')) $('progressFill').style.width = '0%';
    if ($('progressText')) $('progressText').textContent = 'Processing: 0/0';

    showToast('⚡ Processing estimates...', 'info', 1500);
    addActivityLog(`Estimating ${uploadedData.length} rows`, 'info');

    try {
      const providerConfig = currentConfig[selectedProvider] || {};
      const result = await window.api.estimate.process(uploadedData, {
        provider: selectedProvider,
        config: providerConfig,
        estimateOnly
      });

      enable($('processBtn'));

      if (!result.ok) {
        showToast(`❌ Estimation failed: ${result.error}`, 'error', 9000);
        addActivityLog(`Estimation failed: ${result.error}`, 'error');
        return;
      }

      estimationResults = result.data || [];
      expandedRows.clear();
      displayCrimResults(estimationResults);

      showToast('✅ Estimation completed', 'success', 2000);
      addActivityLog(`Estimation completed: ${estimationResults.length} items`, 'success');

      const uploadBtn = $('uploadJiraBtn');
      if (uploadBtn) uploadBtn.style.display = estimateOnly ? 'none' : 'inline-block';

    } catch (e) {
      enable($('processBtn'));
      showToast(`❌ Estimation failed: ${e.message}`, 'error', 9000);
      addActivityLog(`Estimation failed: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------
  // Modal (shared)
  // ---------------------------------------------------------
  function buildDonutGradient(segments) {
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    let acc = 0;
    const stops = segments.map(s => {
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
      .filter(x => x.value > 0);

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

    legend.innerHTML = segments.map(s => {
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
    if (!text) return `<div class="empty-state">No reasoning returned by provider.</div>`;
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
    const tag = row?.crim_type || 'N/A';
    const complexity = row?.complexity || 'N/A';
    const effort = Number(row?.finalEffort ?? row?.hours ?? row?.effortHours ?? 0);

    title.textContent = summary;
    meta.innerHTML = `
      <span class="pill">${escapeHtml(tag)}</span>
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
      const viz = $('detailViz');
      if (viz) viz.style.display = 'grid';
      renderWbsDonutAndLegend(row);
      body.innerHTML = '';
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
  // CRIM: Results table
  // ---------------------------------------------------------
  function displayCrimResults(results) {
    const tbody = $('resultsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let completed = 0;
    let totalEffort = 0;

    (results || []).forEach((r, idx) => {
      const ok = Boolean(r.ok);
      const status = ok ? '✅ Done' : `❌ ${r.error || 'Failed'}`;

      if (ok) {
        completed += 1;
        totalEffort += Number(r.finalEffort ?? r.hours ?? 0);
      }

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
        <td>${escapeHtml(r.summary || 'N/A')}</td>
        <td>${escapeHtml(r.crim_type || 'N/A')}</td>
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
                <span class="pill">${escapeHtml(r.crim_type || 'N/A')}</span>
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
      progressText.textContent = `Completed: ${completed}/${results.length} · Total Effort: ${totalEffort.toFixed(1)}h`;
    }
  }

  // ---------------------------------------------------------
  // CRIM: Exports
  // ---------------------------------------------------------
  function wbsToCsv(row) {
    const wbs = row?.wbs || {};
    const header = toCsvRow(['Activity', 'Hours']);
    const lines = Object.entries(wbs).map(([k, v]) => toCsvRow([k, Number(v || 0).toFixed(1)]));
    return [header, ...lines].join('\n');
  }

  function resultsToCsv(rows) {
    const header = toCsvRow(['Summary', 'CRIM Type', 'Complexity', 'Total Effort (h)']);
    const lines = (rows || []).map(r => toCsvRow([
      r.summary || '',
      r.crim_type || '',
      r.complexity || '',
      Number(r.finalEffort ?? r.hours ?? 0).toFixed(1)
    ]));
    return [header, ...lines].join('\n');
  }

  // ---------------------------------------------------------
  // Jira Upload
  // ---------------------------------------------------------
  function buildJiraTicketsUrl(jiraBaseUrl, issueKeys = []) {
    const base = String(jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base || !Array.isArray(issueKeys) || issueKeys.length === 0) return null;
    const keys = issueKeys.filter(Boolean).join(',');
    const jql = `key in (${keys})`;
    return `${base}/issues/?jql=${encodeURIComponent(jql)}`;
  }

  function showViewJiraTicketsButton(jiraUrl, issueKeys) {
    const uploadBtn = $('uploadJiraBtn');
    const container = uploadBtn?.parentElement;
    if (!container) return;

    const existing = $('viewJiraTicketsBtn');
    if (existing) existing.remove();

    const url = buildJiraTicketsUrl(jiraUrl, issueKeys);
    if (!url) return;

    const btn = document.createElement('button');
    btn.id = 'viewJiraTicketsBtn';
    btn.className = 'btn btn-outline';
    btn.type = 'button';
    btn.textContent = `🔗 View Jira Tickets (${issueKeys.length})`;
    btn.addEventListener('click', async () => {
      const res = await openExternal(url);
      if (!res?.ok) {
        showToast(`❌ Failed to open Jira: ${res?.error || 'Unknown error'}`, 'error', 7000);
      }
    });

    container.appendChild(btn);
  }

  async function uploadToJira() {
    if (!currentConfig.jira?.url) {
      showToast('❌ Jira configuration not found. Configure Jira in Settings.', 'error', 7000);
      return;
    }

    const projectKey = String($('jiraProjectSelect')?.value || '').trim();
    if (!projectKey) {
      showToast('❌ Please select a Jira project', 'error', 6000);
      return;
    }

    if (!estimationResults || estimationResults.length === 0) {
      showToast('❌ No estimation results available to upload', 'error', 6000);
      return;
    }

    disable($('uploadJiraBtn'));
    showToast('📤 Uploading to Jira...', 'info', 1500);
    addActivityLog(`Uploading ${estimationResults.length} tickets to ${projectKey}`, 'info');

    try {
      const tickets = estimationResults.map(r => {
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
            timeestimate: Math.round(totalHours * 3600)
          }
        };
      });

      const res = await window.api.jira.createTickets(
        tickets,
        currentConfig.jira,
        {
          crimFieldName: 'C_CRIM_TYPE',
          failIfCrimFieldMissing: false
        }
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

      const results = data.results || [];
      const createdKeys = results.filter(x => x.ok && x.key).map(x => x.key);
      if (createdKeys.length) showViewJiraTicketsButton(currentConfig.jira.url, createdKeys);

      showToast(`✅ Created ${data.created ?? createdKeys.length}/${data.total ?? tickets.length} tickets`, 'success', 3500);
      addActivityLog(`Created ${data.created ?? createdKeys.length} Jira tickets`, 'success');

    } catch (e) {
      enable($('uploadJiraBtn'));
      showToast(`❌ Jira upload failed: ${e.message}`, 'error', 9000);
      addActivityLog(`Jira upload failed: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------
  // SFD: Reset UI
  // ---------------------------------------------------------
  function sfdResetUI() {
    sfdFile = null;
    sfdParsed = null;
    sfdActivities = [];
    sfdClassified = [];
    sfdEstimated = null;

    sfdPreviewFilters = {
      query: '',
      minConfidence: 0.55,
      subtype: 'ALL',
      showAcceptance: true,
      showIgnored: false,
    };
    sfdIgnoredActivities = new Set();

    const idsToHide = [
      'sfdExtractCard', 'sfdClassifyCard', 'sfdEstimateCard',
      'sfdActivitiesTableWrap', 'sfdClassifiedTableWrap', 'sfdEstimatedTableWrap',
      'sfdParseMeta', 'sfdParseError', 'sfdTotals'
    ];

    idsToHide.forEach(id => hide($(id)));

    const tb1 = $('sfdActivitiesTbody'); if (tb1) tb1.innerHTML = '';
    const tb2 = $('sfdClassifiedTbody'); if (tb2) tb2.innerHTML = '';
    const tb3 = $('sfdEstimatedTbody'); if (tb3) tb3.innerHTML = '';

    const sum = $('sfdExtractSummary'); if (sum) sum.textContent = '';
    const meta = $('sfdParseMeta'); if (meta) meta.textContent = '';
    const err = $('sfdParseError'); if (err) err.textContent = '';

    const pFill = $('sfdProgressFill'); if (pFill) pFill.style.width = '0%';
    const pText = $('sfdProgressText'); if (pText) pText.textContent = 'Ready';

    const inp = $('sfdFileInput'); if (inp) inp.value = '';

    const controls = $('sfdPreviewControls');
    if (controls) controls.remove();

    const subtypeSel = $('sfdSubtypeFilter');
    if (subtypeSel) subtypeSel.dataset.bound = '';
  }

  function sfdShowError(msg) {
    const box = $('sfdParseError');
    if (!box) return;
    box.style.display = 'block';
    box.classList.add('show', 'error');
    box.classList.remove('success');
    box.textContent = msg;
  }

  function sfdShowMeta(metaObj) {
    const meta = $('sfdParseMeta');
    if (!meta) return;
    meta.style.display = 'block';

    const m = metaObj || {};
    meta.textContent = `File: ${m.fileName || 'N/A'} | Type: ${m.ext || 'N/A'} | Chars: ${m.chars || 0}`;
  }

  // ---------------------------------------------------------
  // SFD: Native browse + parse
  // ---------------------------------------------------------
  async function browseAndParseSfd() {
    if (!window.api?.sfd?.browse) {
      showToast('❌ SFD browse API not available (check preload.js & IPC wiring)', 'error', 8000);
      return;
    }

    try {
      const pick = await window.api.sfd.browse();
      if (!pick?.ok) {
        showToast(pick?.error || 'SFD selection cancelled', 'warning', 5000);
        return;
      }

      const filePath = String(pick.filePath || '').trim();
      if (!filePath) {
        showToast('❌ No file path returned from SFD browse', 'error', 7000);
        return;
      }

      await handleSfdFilePath(filePath);

    } catch (e) {
      showToast(`❌ Failed to browse SFD: ${e?.message || 'Unknown error'}`, 'error', 9000);
    }
  }

  async function handleSfdFilePath(filePath, displayName = null) {
    if (!filePath) return;

    // reset state
    sfdFile = { name: displayName || String(filePath).split(/[\\/]/).pop(), path: filePath };
    sfdParsed = null;
    sfdActivities = [];
    sfdClassified = [];
    sfdEstimated = null;

    hide($('sfdParseError'));
    hide($('sfdParseMeta'));
    hide($('sfdActivitiesTableWrap'));
    hide($('sfdClassifiedTableWrap'));
    hide($('sfdEstimatedTableWrap'));
    hide($('sfdTotals'));

    const okExt = ['.pdf', '.docx', '.txt', '.md']
      .some(ext => filePath.toLowerCase().endsWith(ext));

    if (!okExt) {
      showToast('❌ Unsupported SFD file type', 'error', 6000);
      return;
    }

    showToast('📄 Parsing SFD document...', 'info', 1500);
    addActivityLog(`SFD selected: ${sfdFile.name}`, 'info');

    const res = await window.api.sfd.parse(filePath);
    if (!res?.ok) {
      showToast(`❌ Parse failed: ${res?.error || 'Unknown error'}`, 'error', 9000);
      return;
    }

	// ✅ Normalize parser response (supports both IPC shapes)
	const parsed =
	  typeof res.text === 'string'
		? res
		: (typeof res.data?.text === 'string' ? res.data : null);

	if (!parsed || !parsed.text) {
	  showToast(
		`❌ ${res?.error || 'No extractable text found'}${
		  res?.hint ? ` — ${res.hint}` : ''
		}`,
		'error',
		8000
	  );
	  return;
	}

	sfdParsed = {
	  text: parsed.text,
	  meta: parsed.meta || {}
	};

    if ($('sfdParseMeta')) {
      $('sfdParseMeta').textContent = `${sfdFile.name} • ${sfdParsed.text.length} chars`;
      show($('sfdParseMeta'));
    }

    show($('sfdExtractCard'));
    showToast('✅ SFD parsed successfully', 'success', 2000);
  }

  async function handleSfdFile(file) {
    if (!file) return;
    const filePath = String(file.path || '').trim();
    if (!filePath) {
      showToast('⚠️ Please use “Browse SFD” (native dialog) to select the document.', 'warning', 6000);
      return;
    }
    await handleSfdFilePath(filePath, file.name);
  }

  // ---------------------------------------------------------
  // SFD: Preview controls (injected)
  // ---------------------------------------------------------
  function ensureSfdPreviewControls() {
    const host = $('sfdActivitiesTableWrap')?.parentElement || $('sfdExtractCard');
    if (!host) return;

    let controls = $('sfdPreviewControls');
    if (controls) return;

    controls = document.createElement('div');
    controls.id = 'sfdPreviewControls';
    controls.style.display = 'grid';
    controls.style.gridTemplateColumns = '1fr 260px 220px 180px 160px';
    controls.style.gap = '12px';
    controls.style.alignItems = 'end';
    controls.style.margin = '12px 0';

    controls.innerHTML = `
      <div>
        <label style="display:block;font-weight:900;margin-bottom:6px;">Search</label>
        <input id="sfdQuery" class="form-control" placeholder="Search title, section, evidence…" />
      </div>
      <div>
        <label style="display:block;font-weight:900;margin-bottom:6px;">Min Confidence</label>
        <input id="sfdMinConf" type="range" min="0.40" max="0.90" step="0.05" value="${Number(sfdPreviewFilters.minConfidence || 0.55)}" style="width:100%;" />
        <div style="margin-top:6px;color:var(--text-tertiary);font-size:12px;">
          <span id="sfdMinConfVal">${Number(sfdPreviewFilters.minConfidence || 0.55).toFixed(2)}</span>
        </div>
      </div>
      <div>
        <label style="display:block;font-weight:900;margin-bottom:6px;">Subtype</label>
        <select id="sfdSubtypeFilter" class="form-control">
          <option value="ALL">ALL</option>
        </select>
      </div>
      <div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:900;">
          <input id="sfdShowAcceptance" type="checkbox" checked />
          Include Acceptance
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:900;margin-top:8px;">
          <input id="sfdShowIgnored" type="checkbox" />
          Show Ignored
        </label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="sfdClearIgnored" class="btn btn-outline" type="button">Clear Ignored</button>
      </div>
    `;

    const tableWrap = $('sfdActivitiesTableWrap');
    host.insertBefore(controls, tableWrap);

    controls.querySelector('#sfdQuery')?.addEventListener('input', (e) => {
      sfdPreviewFilters.query = e.target.value || '';
      sfdRenderActivities(sfdActivities);
    });

    controls.querySelector('#sfdMinConf')?.addEventListener('input', (e) => {
      sfdPreviewFilters.minConfidence = Number(e.target.value);
      const v = controls.querySelector('#sfdMinConfVal');
      if (v) v.textContent = Number(e.target.value).toFixed(2);
      sfdRenderActivities(sfdActivities);
    });

    controls.querySelector('#sfdSubtypeFilter')?.addEventListener('change', (e) => {
      sfdPreviewFilters.subtype = e.target.value;
      sfdRenderActivities(sfdActivities);
    });

    controls.querySelector('#sfdShowAcceptance')?.addEventListener('change', (e) => {
      sfdPreviewFilters.showAcceptance = Boolean(e.target.checked);
      sfdRenderActivities(sfdActivities);
    });

    controls.querySelector('#sfdShowIgnored')?.addEventListener('change', (e) => {
      sfdPreviewFilters.showIgnored = Boolean(e.target.checked);
      sfdRenderActivities(sfdActivities);
    });

    controls.querySelector('#sfdClearIgnored')?.addEventListener('click', () => {
      sfdIgnoredActivities = new Set();
      sfdRenderActivities(sfdActivities);
      showToast('✅ Ignored list cleared', 'success', 1800);
    });
  }

  // ---------------------------------------------------------
  // SFD: Render Activities (with filters)
  // ---------------------------------------------------------
  function sfdRenderActivities(list) {
    const wrap = $('sfdActivitiesTableWrap');
    const tbody = $('sfdActivitiesTbody');
    if (!wrap || !tbody) return;

    ensureSfdPreviewControls();

    const all = Array.isArray(list) ? list : [];

    // Build subtype options once
    const subtypeSel = $('sfdSubtypeFilter');
    if (subtypeSel && !subtypeSel.dataset.bound) {
      const subtypeSet = new Set(all.map(a => String(a?.subtypeHint || '').trim()).filter(Boolean));
      const subtypeOptions = ['ALL', ...Array.from(subtypeSet).sort()];
      subtypeSel.innerHTML = subtypeOptions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
      subtypeSel.value = sfdPreviewFilters.subtype || 'ALL';
      subtypeSel.dataset.bound = '1';
    }

    const q = String(sfdPreviewFilters.query || '').toLowerCase();

    const filtered = all.filter(a => {
      const conf = Number(a?.confidence ?? 0);
      const subtype = String(a?.subtypeHint || '').trim();
      const sectionClass = String(a?.evidence?.sectionClass || 'IN_SCOPE_REQUIREMENTS');
      const isAcceptance = sectionClass === 'ACCEPTANCE';
      const ignored = sfdIgnoredActivities.has(a?.id);

      if (!sfdPreviewFilters.showIgnored && ignored) return false;
      if (!sfdPreviewFilters.showAcceptance && isAcceptance) return false;
      if (conf < Number(sfdPreviewFilters.minConfidence || 0)) return false;
      if (sfdPreviewFilters.subtype !== 'ALL' && subtype !== sfdPreviewFilters.subtype) return false;

      if (q) {
        const t = `${a?.title || ''} ${a?.description || ''} ${a?.evidence?.sectionPath || ''} ${a?.evidence?.quote || ''}`.toLowerCase();
        if (!t.includes(q)) return false;
      }

      return true;
    });

    // summary
    if ($('sfdExtractSummary')) {
      const ignoredCnt = all.filter(x => sfdIgnoredActivities.has(x?.id)).length;
      const accCnt = all.filter(x => String(x?.evidence?.sectionClass || '') === 'ACCEPTANCE').length;
      $('sfdExtractSummary').textContent = `Showing ${filtered.length}/${all.length} · Ignored: ${ignoredCnt} · Acceptance: ${accCnt} · MinConf: ${Number(sfdPreviewFilters.minConfidence).toFixed(2)}`;
    }

    tbody.innerHTML = '';

    filtered.forEach((a, i) => {
      const conf = Number(a?.confidence ?? 0);
      const sectionPath = a?.evidence?.sectionPath || '';
      const quote = a?.evidence?.quote || a?.source?.evidence || a?.description || '';
      const ignored = sfdIgnoredActivities.has(a?.id);

      const tr = document.createElement('tr');
      tr.className = 'card-row';
      tr.style.opacity = ignored ? '0.45' : '1';
      tr.innerHTML = `
        <td style="white-space:nowrap;">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" class="sfd-include-toggle" data-id="${escapeHtml(a.id)}" ${ignored ? '' : 'checked'} />
            <span style="font-weight:900;color:#94a3b8;">${i + 1}</span>
          </label>
        </td>
        <td class="sfd-wrap">
          <div style="font-weight:900;">${escapeHtml(a.title || '')}</div>
          <div style="margin-top:6px;color:var(--text-tertiary);font-size:12px;">${escapeHtml(sectionPath)}</div>
        </td>
        <td><span class="badge">${escapeHtml(a.subtypeHint || 'N/A')}</span></td>
        <td><span class="badge">${Math.round(conf * 100)}%</span></td>
        <td class="sfd-wrap" title="${escapeHtml(quote)}">${escapeHtml(String(quote).slice(0, 220))}${String(quote).length > 220 ? '…' : ''}</td>
      `;

      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.sfd-include-toggle').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        if (!id) return;
        if (!e.target.checked) sfdIgnoredActivities.add(id);
        else sfdIgnoredActivities.delete(id);
        sfdRenderActivities(all);
      });
    });

    wrap.style.display = 'block';
  }

  // ---------------------------------------------------------
  // SFD: Render classified
  // ---------------------------------------------------------
  function sfdRenderClassified(list) {
    const wrap = $('sfdClassifiedTableWrap');
    const tbody = $('sfdClassifiedTbody');
    if (!wrap || !tbody) return;

    tbody.innerHTML = '';

    (list || []).forEach((a, i) => {
      const tr = document.createElement('tr');
      tr.className = 'card-row';
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="sfd-wrap">${escapeHtml(a.title || '')}</td>
        <td><span class="badge">${escapeHtml(a.activitySubtype || a.subtypeHint || 'N/A')}</span></td>
        <td><span class="badge">${escapeHtml(a.complexity || 'N/A')}</span></td>
        <td>
          <button class="btn btn-mini btn-glass sfd-view-btn" data-action="sfd-reason" data-idx="${i}">View</button>
        </td>
        <td>${a.ok === false ? `❌ ${escapeHtml(a.error || 'Failed')}` : '✅ Ready'}</td>
      `;
      tbody.appendChild(tr);
    });

    wrap.style.display = 'block';
  }

  // ---------------------------------------------------------
  // SFD: Render estimated
  // ---------------------------------------------------------
  function sfdRenderEstimated(est) {
    const wrap = $('sfdEstimatedTableWrap');
    const tbody = $('sfdEstimatedTbody');
    const totals = $('sfdTotals');
    if (!wrap || !tbody || !totals) return;

    const results = est?.results || [];
    const t = est?.totals || {};

    totals.style.display = 'block';
    totals.textContent = `Activities: ${t.totalActivities || 0} | Estimated: ${t.estimatedActivities || 0} | Total: ${(t.totalEffortHours || 0).toFixed(1)}h (${(t.totalEffortDays || 0).toFixed(1)}d)`;

    tbody.innerHTML = '';

    results.forEach((r, i) => {
      const ok = Boolean(r.ok);
      const effort = ok ? Number(r.effortHours || 0) : 0;

      const tr = document.createElement('tr');
      tr.className = 'card-row';
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="sfd-wrap">${escapeHtml(r.title || '')}</td>
        <td><span class="badge">${escapeHtml(r.activitySubtype || 'N/A')}</span></td>
        <td><span class="badge">${escapeHtml(r.complexity || 'N/A')}</span></td>
        <td><span class="badge badge-strong">${ok ? effort.toFixed(1) : 'N/A'}h</span></td>
        <td>
          ${ok ? `<button class="btn btn-mini btn-glass sfd-view-btn" data-action="sfd-wbs" data-idx="${i}">View WBS</button>` : `<span class="muted">N/A</span>`}
        </td>
        <td>
          ${ok ? `<button class="btn btn-mini btn-glass sfd-view-btn" data-action="sfd-reason-est" data-idx="${i}">View</button>` : `<span class="muted">N/A</span>`}
        </td>
        <td>${ok ? '✅ Done' : `❌ ${escapeHtml(r.error || 'Failed')}`}</td>
      `;

      tbody.appendChild(tr);
    });

    wrap.style.display = 'block';
  }

  function openSfdDetailModal(kind, row, label = 'SFD') {
    const modalRow = {
      summary: row?.title || 'SFD Activity',
      crim_type: label,
      complexity: row?.complexity || 'N/A',
      finalEffort: Number(row?.effortHours ?? 0),
      hours: Number(row?.effortHours ?? 0),
      wbs: row?.wbs || {},
      reasoning: row?.reasoning || '',
      description: row?.description || row?.source?.evidence || ''
    };
    openDetailModal(kind, modalRow);
  }

  // ---------------------------------------------------------
  // Boot + wire events
  // ---------------------------------------------------------
  function wireEvents() {
    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => showSection(item.dataset.section));
    });

    // Header buttons
    $('settingsBtn')?.addEventListener('click', () => showSection('settings'));
    $('uploadExcelBtn')?.addEventListener('click', () => showSection('upload'));
    $('setupConfigBtn')?.addEventListener('click', () => showSection('settings'));

    // Settings provider switch
    $('providerType')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      currentConfig.provider = provider;
      showProviderConfig(provider);
      updateStatus();
    });

    // Save/reset config
    $('saveConfigBtn')?.addEventListener('click', saveConfiguration);
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
        token: $('jiraToken')?.value || ''
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

    $('refreshProjectsBtn')?.addEventListener('click', async () => {
      await fetchAndBindProjects(currentConfig.jira);
      showToast('✅ Projects refreshed', 'success', 2000);
    });

    $('estimateOnly')?.addEventListener('change', (e) => {
      const disabled = Boolean(e.target.checked);
      $('jiraProjectSelect') && ($('jiraProjectSelect').disabled = disabled);
      $('refreshProjectsBtn') && ($('refreshProjectsBtn').disabled = disabled);
    });

    // CRIM buttons
    $('processBtn')?.addEventListener('click', processCrimEstimates);
    $('cancelBtn')?.addEventListener('click', resetCrimUI);
    $('newUploadBtn')?.addEventListener('click', resetCrimUI);
    $('uploadJiraBtn')?.addEventListener('click', uploadToJira);

    // CRIM dropzone + file input
    const dropzone = $('dropzone');
    const fileInput = $('fileInput');

    dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleExcelFile(f);
    });

    fileInput?.addEventListener('change', (e) => {
      const f = e.target?.files?.[0];
      if (f) handleExcelFile(f);
    });

    // CRIM results table click handlers
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
        displayCrimResults(estimationResults);
      }
    });

    // Modal controls
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetailModal();
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

    $('exportWbsCsvBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || 'WBS');
      downloadText(`${name}-WBS.csv`, wbsToCsv(modalActiveRow), 'text/csv');
      showToast('✅ WBS CSV exported', 'success', 1500);
    });

    $('exportReasonTxtBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || 'Reasoning');
      downloadText(`${name}-Reasoning.txt`, String(modalActiveRow.reasoning || ''), 'text/plain');
      showToast('✅ Reasoning exported', 'success', 1500);
    });

    $('exportRowJsonBtn')?.addEventListener('click', () => {
      if (!modalActiveRow) return;
      const name = sanitizeFilename(modalActiveRow.summary || 'Row');
      downloadText(`${name}.json`, JSON.stringify(modalActiveRow, null, 2), 'application/json');
      showToast('✅ Row JSON exported', 'success', 1500);
    });

    $('exportAllJsonBtn')?.addEventListener('click', () => {
      downloadText('EffortIQ-Results.json', JSON.stringify(estimationResults || [], null, 2), 'application/json');
      showToast('✅ Exported all results (JSON)', 'success', 2000);
    });

    $('exportAllCsvBtn')?.addEventListener('click', () => {
      downloadText('EffortIQ-Results.csv', resultsToCsv(estimationResults || []), 'text/csv');
      showToast('✅ Exported all results (CSV)', 'success', 2000);
    });

    // -----------------------------------------------------
    // SFD section wiring
    // -----------------------------------------------------

    $('sfdBrowseBtn')?.addEventListener('click', async () => {
      await browseAndParseSfd();
    });

    const sfdDrop = $('sfdDropzone');
    sfdDrop?.addEventListener('dragover', (e) => { e.preventDefault(); sfdDrop.classList.add('drag-over'); });
    sfdDrop?.addEventListener('dragleave', () => sfdDrop.classList.remove('drag-over'));
    sfdDrop?.addEventListener('drop', async (e) => {
      e.preventDefault();
      sfdDrop.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) await handleSfdFile(f);
    });

    // We intentionally discourage file input for SFD (fake paths)
    $('sfdFileInput')?.addEventListener('change', async () => {
      showToast('⚠️ Please use “Browse SFD” (native dialog). File input paths are blocked in Electron.', 'warning', 6000);
    });

    $('sfdResetBtn')?.addEventListener('click', sfdResetUI);

    // Extract
    $('sfdExtractBtn')?.addEventListener('click', async () => {
      if (!window.api?.sfd?.extract) {
        showToast('❌ SFD API not available (preload/IPC missing)', 'error', 7000);
        return;
      }

      if (!sfdParsed?.text) {
        showToast('❌ Please upload and parse an SFD first', 'error', 6000);
        return;
      }

      const maxActivities = Number($('sfdMaxActivities')?.value || 200);
      showToast('🧠 Extracting activities...', 'info', 1500);

      const res = await window.api.sfd.extract(sfdParsed.text, { maxActivities, includeAcceptance: true });
      if (!res?.ok) {
        showToast(`❌ Extract failed: ${res?.error || 'Unknown error'}`, 'error', 8000);
        return;
      }

      const data = res.data || {};
      sfdActivities = data.activities || [];

      // reset preview filter state for fresh extraction
      sfdIgnoredActivities = new Set();
      sfdPreviewFilters.query = '';
      sfdPreviewFilters.minConfidence = 0.55;
      sfdPreviewFilters.subtype = 'ALL';
      sfdPreviewFilters.showAcceptance = true;
      sfdPreviewFilters.showIgnored = false;

      const subtypeSel = $('sfdSubtypeFilter');
      if (subtypeSel) subtypeSel.dataset.bound = '';

      sfdRenderActivities(sfdActivities);
      show($('sfdClassifyCard'));

      showToast(`✅ Extracted ${sfdActivities.length} activities`, 'success', 2000);
    });

    // Classify
    $('sfdClassifyBtn')?.addEventListener('click', async () => {
      if (!window.api?.sfd?.classify) {
        showToast('❌ SFD API not available (preload/IPC missing)', 'error', 7000);
        return;
      }

      const chosen = (sfdActivities || []).filter(a => !sfdIgnoredActivities.has(a.id));
      if (!chosen.length) {
        showToast('❌ No activities to classify (all ignored or none extracted).', 'error', 6000);
        return;
      }

      const provider = $('sfdProvider')?.value || currentConfig.provider || 'openai';
      const providerConfig = currentConfig[provider] || {};
      const batchSize = Number($('sfdBatchSize')?.value || 10);
      const includeSourceHints = Boolean($('sfdIncludeSourceHints')?.checked);

      showToast('✨ Classifying activities...', 'info', 1500);

      const res = await window.api.sfd.classify(
        chosen,
        provider,
        providerConfig,
        { batchSize, includeSourceHints }
      );

      if (!res?.ok) {
        showToast(`❌ Classify failed: ${res?.error || 'Unknown error'}`, 'error', 8000);
        return;
      }

      const data = res.data || {};
      sfdClassified = data.activities || [];
      sfdRenderClassified(sfdClassified);
      show($('sfdEstimateCard'));

      showToast(`✅ Classified ${sfdClassified.length} activities`, 'success', 2000);
    });

    // Estimate
    $('sfdEstimateBtn')?.addEventListener('click', async () => {
      if (!window.api?.sfd?.estimate) {
        showToast('❌ SFD API not available (preload/IPC missing)', 'error', 7000);
        return;
      }

      const chosen = (sfdClassified || []).filter(a => !sfdIgnoredActivities.has(a.id));
      if (!chosen.length) {
        showToast('❌ No classified activities to estimate (all ignored or none).', 'error', 6000);
        return;
      }

      const fill = $('sfdProgressFill');
      const text = $('sfdProgressText');
      if (fill) fill.style.width = '35%';
      if (text) text.textContent = 'Estimating...';

      const res = await window.api.sfd.estimate(chosen);
      if (!res?.ok) {
        if (fill) fill.style.width = '0%';
        if (text) text.textContent = 'Failed';
        showToast(`❌ Estimate failed: ${res?.error || 'Unknown error'}`, 'error', 8000);
        return;
      }

      sfdEstimated = res.data || {};
      if (fill) fill.style.width = '100%';
      if (text) text.textContent = 'Completed';

      sfdRenderEstimated(sfdEstimated);
      showToast('✅ SFD estimation completed', 'success', 2000);
    });

    // SFD table view buttons
    $('sfdClassifiedTbody')?.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.sfd-view-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = Number(btn.dataset.idx);
      const row = (sfdClassified || [])[idx];
      if (!row) return;
      if (action === 'sfd-reason') openSfdDetailModal('reason', row, 'SFD');
    });

    $('sfdEstimatedTbody')?.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.sfd-view-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = Number(btn.dataset.idx);
      const row = (sfdEstimated?.results || [])[idx];
      if (!row) return;
      if (action === 'sfd-wbs') openSfdDetailModal('wbs', row, 'SFD');
      if (action === 'sfd-reason-est') openSfdDetailModal('reason', row, 'SFD');
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
        errorLog('[EffortIQ] window.api not available – running UI in degraded mode');
        showToast('⚠️ Backend not connected. UI loaded in degraded mode.', 'warning', 8000);
        addActivityLog('Backend API not available (preload/IPC issue). Limited functionality.', 'error');
      }

      bindLiveProgress();
      if (window.api?.config?.load) await loadConfiguration();

      showToast('👋 Welcome to EffortIQ!', 'info', 1500);
      addActivityLog('Application started', 'info');

    } catch (e) {
      errorLog('Renderer boot failed:', e);
      showToast(`❌ UI boot failed: ${e.message}`, 'error', 9000);
    }
  });

})();
