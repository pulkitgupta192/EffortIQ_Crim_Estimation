// ============================================
// EffortIQ -FD: Activities only in table + single WBS + overall reasoning// EffortIQ - Renderer Process (UI Logic)
// ============================================
(() => {
  'use strict';

  console.log('[EffortIQ] Renderer loaded');

  const DEBUG = localStorage.getItem('effortiq:debug') === '1';
  const log = (...args) => DEBUG && console.log('[EffortIQ]', ...args);
  const errorLog = (...args) => console.error('[EffortIQ]', ...args);

  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.style.display = 'block'; };
  const hide = (el) => { if (el) el.style.display = 'none'; };
  const enable = (el) => { if (el) el.disabled = false; };
  const disable = (el) => { if (el) el.disabled = true; };

function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function buildCreatedIssuesUrl(jiraBaseUrl, issueKeys) {
  const base = normalizeBaseUrl(jiraBaseUrl);
  const keys = Array.isArray(issueKeys) ? issueKeys.filter(Boolean) : [];

  if (!base || keys.length === 0) return null;

  // Single issue: open the ticket directly
  if (keys.length === 1) {
    return `${base}/browse/${encodeURIComponent(keys[0])}`;
  }

  // Multiple issues: open Issue Navigator with JQL filter
  const jql = `key in (${keys.join(',')}) ORDER BY created DESC`;
  return `${base}/issues/?jql=${encodeURIComponent(jql)}`;
}

  function escapeHtml(input) {
    const s = String(input ?? '');
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let currentConfig = {};
  let uploadedData = [];
  let estimationResults = [];
  const expandedRows = new Set();
  let lastCreatedJiraUrl = null;

  let currentMode = 'xlsx';
  let uploadedFile = null;
  let modalActiveRow = null;
  let modalActiveTab = 'wbs';
  let progressSubscribed = false;

  // SFD helpers
  let sfdFinalRow = null;

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
    sfdFinalRow = null;

    if (fileInput) fileInput.value = '';
    hide($('previewCard'));

    // Hide SFD summary by default
    hide($('sfdSummaryBar'));

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

		// ✅ RESTORE XLSX preview rendering
		populatePreviewTable(uploadedData);

		show($('previewCard'));
		show($('optionsCard'));

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

  // -----------------------------
  // Results rendering
  // -----------------------------
  function isSfdActivityRow(row) {
    return currentMode === 'sfd' && row?.kind === 'sfd_activity';
  }
  function isSfdFinalRow(row) {
    return currentMode === 'sfd' && row?.kind === 'sfd_final';
  }

  function setTableHeadersForMode() {
    const colSno = $('colSno');
    const colSummary = $('colSummary');
    const colCrim = $('colCrim');
    const colComplexity = $('colComplexity');
    const colEffort = $('colEffort');
    const colWbs = $('colWbs');
    const colReason = $('colReason');
    const colStatus = $('colStatus');

    if (colSno) colSno.textContent = 'S.No';

    if (currentMode === 'sfd') {
      if (colSummary) colSummary.textContent = 'Activity';
      if (colCrim) colCrim.textContent = 'CRIM Type';
      if (colComplexity) colComplexity.textContent = 'Complexity';
      if (colEffort) colEffort.textContent = 'Dev Effort (h)';
      if (colWbs) colWbs.textContent = 'WBS'; // will be hidden in rows (single button used)
      if (colReason) colReason.textContent = 'AI Reasoning';
      if (colStatus) colStatus.textContent = 'Status';
    } else {
      if (colSummary) colSummary.textContent = 'Summary';
      if (colCrim) colCrim.textContent = 'CRIM Type';
      if (colComplexity) colComplexity.textContent = 'Complexity';
      if (colEffort) colEffort.textContent = 'Total Effort (h)';
      if (colWbs) colWbs.textContent = 'WBS';
      if (colReason) colReason.textContent = 'AI Reasoning';
      if (colStatus) colStatus.textContent = 'Status';
    }
  }

  function formatReasoning(reasoning) {
    const text = String(reasoning || '').trim();
    if (!text) return '<div class="empty-state">No reasoning returned by provider.</div>';
    return `<div class="reason-box">${escapeHtml(text)}</div>`;
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

    // effort display depends on row type
    const effort = (currentMode === 'sfd' && row?.kind === 'sfd_activity')
      ? Number(row?.devEffortHours || 0)
      : Number(row?.finalEffort ?? row?.hours ?? 0);

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

  function updateSfdSummary(finalRow) {
    const bar = $('sfdSummaryBar');
    const eff = $('sfdFinalEffortValue');
    const days = $('sfdFinalEffortDays');

    if (!bar || !eff || !days) return;

    if (!finalRow) {
      hide(bar);
      return;
    }

    const totalHours = Number(finalRow.finalEffort ?? finalRow.hours ?? 0);
    const md = Number(finalRow.totalEffortDays ?? 0);

    eff.textContent = `${totalHours.toFixed(1)}h`;
    days.textContent = `${md.toFixed(3)} md`;

    show(bar);
  }

	function populatePreviewTable(rows) {
	  const tbody = $('previewTableBody');
	  const countEl = $('previewCount');

	  if (!tbody) return;

	  tbody.innerHTML = '';

	  const data = Array.isArray(rows) ? rows : [];
	  const maxPreview = 25; // ✅ legacy-friendly, fast

	  if (countEl) {
		countEl.textContent = `Previewing ${Math.min(data.length, maxPreview)} of ${data.length} rows`;
	  }

	  data.slice(0, maxPreview).forEach((row) => {
		const tr = document.createElement('tr');

		tr.innerHTML = `
		  <td>${escapeHtml(row.summary || '')}</td>
		  <td class="preview-desc clamp-1">
			${escapeHtml(row.description || '')}
		  </td>
		  <td>${escapeHtml(row.crim_type || '')}</td>
		`;

		tbody.appendChild(tr);
	  });

	  if (!data.length) {
		tbody.innerHTML = `
		  <tr>
			<td colspan="3" class="muted">No valid rows found in the Excel file</td>
		  </tr>
		`;
	  }
	}

  function displayResults(results) {
    const tbody = $('resultsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    setTableHeadersForMode();

    if (currentMode === 'sfd') {
      // ✅ SFD: show only activity rows in table
      sfdFinalRow = (results || []).find((r) => r?.ok && isSfdFinalRow(r)) || null;
      updateSfdSummary(sfdFinalRow);

      const activityRows = (results || []).filter((r) => r && isSfdActivityRow(r));

      // Render activity rows with S.No
      activityRows.forEach((r, idx) => {
        const ok = Boolean(r?.ok);
        const status = ok ? '✅ Done' : `❌ ${r?.error || 'Failed'}`;

        const summary = r.summary || r.title || 'N/A';
        const crimType = r.crim_type || 'N/A';
        const complexity = ok ? (r.complexity || 'N/A') : 'N/A';
        const effort = ok ? Number(r.devEffortHours || 0) : NaN;

        const viewWbsCell = '<span class="muted">N/A</span>'; // single button used
        const viewReasonCell = ok
          ? `<button class="btn btn-mini btn-glass view-btn" data-action="view-reason" data-idx="${idx}" data-sfd="1">View</button>`
          : `<span class="muted">N/A</span>`;

        const tr = document.createElement('tr');
        tr.className = 'card-row';
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td>${escapeHtml(summary)}</td>
          <td>${escapeHtml(crimType)}</td>
          <td><span class="badge">${escapeHtml(complexity)}</span></td>
          <td><span class="badge badge-strong">${ok ? effort.toFixed(1) : 'N/A'}h</span></td>
          <td>${viewWbsCell}</td>
          <td>${viewReasonCell}</td>
          <td>${escapeHtml(status)}</td>
        `;
        tbody.appendChild(tr);
      });

      // progress footer text
      const progressText = $('progressText');
      if (progressText && sfdFinalRow?.ok) {
        const totalHours = Number(sfdFinalRow.finalEffort ?? sfdFinalRow.hours ?? 0);
        progressText.textContent = `Completed: ${activityRows.length}/${activityRows.length} • Final Effort: ${totalHours.toFixed(1)}h`;
      }

      return;
    }

    // ✅ XLSX: keep behavior same (just add S.No column visually)
    let completed = 0;
    let effortShown = 0;

    (results || []).forEach((r, idx) => {
      const ok = Boolean(r?.ok);
      const status = ok ? '✅ Done' : `❌ ${r?.error || 'Failed'}`;

      if (ok) {
        completed += 1;
        effortShown += Number(r?.finalEffort ?? r?.hours ?? 0);
      }

      const summary = r.summary || r.title || 'N/A';
      const crimType = r.crim_type || r.category || 'N/A';
      const complexity = ok ? (r.complexity || 'N/A') : 'N/A';
      const effort = ok ? Number(r?.finalEffort ?? r?.hours ?? 0) : NaN;

      const viewWbsCell = ok
        ? `<button class="btn btn-mini btn-glass view-btn" data-action="view-wbs" data-idx="${idx}">View WBS</button>`
        : `<span class="muted">N/A</span>`;

      const viewReasonCell = ok
        ? `<button class="btn btn-mini btn-glass view-btn" data-action="view-reason" data-idx="${idx}">View</button>`
        : `<span class="muted">N/A</span>`;

      const tr = document.createElement('tr');
      tr.className = 'card-row';
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escapeHtml(summary)}</td>
        <td>${escapeHtml(crimType)}</td>
        <td><span class="badge">${escapeHtml(complexity)}</span></td>
        <td><span class="badge badge-strong">${ok ? effort.toFixed(1) : 'N/A'}h</span></td>
        <td>${viewWbsCell}</td>
        <td>${viewReasonCell}</td>
        <td>${escapeHtml(status)}</td>
      `;
      tbody.appendChild(tr);
    });

    const progressFill = $('progressFill');
    const progressText = $('progressText');
    const percent = results?.length ? (completed / results.length) * 100 : 0;
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `Completed: ${completed}/${results.length} • Effort shown: ${effortShown.toFixed(1)}h`;
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

    // Ensure summary hidden until SFD result is available
    hide($('sfdSummaryBar'));

    showToast('⚡ Processing estimates...', 'info', 2000);
    addActivityLog(`Estimating (${currentMode.toUpperCase()})`, 'info');

    const providerConfig = currentConfig[selectedProvider] || {};

    try {
      if (currentMode === 'xlsx') {
        if (!uploadedData?.length) {
          enable($('processBtn'));
          showToast('❌ No Excel rows to process', 'error', 6000);
          return;
        }

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
        // SFD: create ONE ticket from FINAL row + attach DOCX
        const finalRow = findSfdFinalRow(estimationResults);
        if (!finalRow) {
          enable($('uploadJiraBtn'));
          showToast('❌ SFD FINAL not found', 'error', 8000);
          return;
        }

        const totalHours = Number(finalRow.finalEffort ?? finalRow.hours ?? 0) || 0;
        const fileName = uploadedFile?.name || 'SFD.docx';

        tickets = [{
          summary: `SFD: ${fileName}`,
          description: `SFD effort estimation generated by EffortIQ.\n\nAttached: ${fileName}`,
          issueType: 'Task',
          project: projectKey,

          // For Jira comment builder:
          sfdActivities: finalRow.sfdActivities || [],
          wbs: finalRow.wbs || {},
          aiReasoning: finalRow.reasoning || '',

          complexity: finalRow.complexity || 'N/A',
          direction: finalRow.direction || 'N/A',
          flow: finalRow.flow || 'N/A',

          // for mandays display
          hoursPerDay: finalRow.hoursPerDay || 8,

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

		const data = res.data;
		if (!data?.ok) {
		  showToast(`❌ Jira upload failed: ${data?.error || 'Unknown error'}`, 'error', 9000);
		  return;
		}

		// ✅ Extract created issue keys from Jira response
		const createdKeys = (data.results || [])
		  .filter(r => r && r.ok && r.key)
		  .map(r => String(r.key).trim())
		  .filter(Boolean);

		// ✅ Build filtered Jira URL (Issue Navigator / browse)
		lastCreatedJiraUrl = buildCreatedIssuesUrl(currentConfig.jira?.url, createdKeys);

		// ✅ Show View Jira button only when we have a filtered URL
		const viewBtn = $('viewJiraBtn');
		if (viewBtn) {
		  if (lastCreatedJiraUrl) {
			viewBtn.style.display = 'inline-block';
			viewBtn.disabled = false;
			viewBtn.textContent = `🔗 View in Jira (${createdKeys.length})`;
		  } else {
			viewBtn.style.display = 'none';
			viewBtn.disabled = true;
		  }
		}

      showToast(`✅ Created ${data.created ?? 0}/${data.total ?? tickets.length} ticket(s)`, 'success', 4000);
      addActivityLog(`Created ${data.created ?? 0}/${data.total ?? tickets.length} Jira ticket(s)`, 'success');
	  
	  const uploadBtn = $('uploadJiraBtn');
		if (uploadBtn) {
		  uploadBtn.disabled = true;            // ✅ prevent duplicate ticket creation
		  uploadBtn.textContent = '✅ Uploaded'; // optional but strongly recommended UX
		}

    } catch (e) {
      enable($('uploadJiraBtn'));
      showToast(`❌ Jira upload failed: ${e.message}`, 'error', 9000);
    }
  }

  function resetProcessingUI(resetFile = true) {
    hide($('resultsCard'));
    hide($('previewCard'));
    hide($('optionsCard'));
    hide($('sfdSummaryBar'));

    const resultsBody = $('resultsTableBody');
    if (resultsBody) resultsBody.innerHTML = '';

    expandedRows.clear();
    modalActiveRow = null;
    modalActiveTab = 'wbs';
    estimationResults = [];
    uploadedData = [];
    sfdFinalRow = null;

    if (resetFile) {
      uploadedFile = null;
      setSelectedFileLabel('');
      if ($('fileInput')) $('fileInput').value = '';
    }

    if ($('uploadJiraBtn')) $('uploadJiraBtn').style.display = 'none';
    if ($('progressFill')) $('progressFill').style.width = '0%';
    if ($('progressText')) $('progressText').textContent = 'Processing: 0/0';
	lastCreatedJiraUrl = null;

	const viewBtn = $('viewJiraBtn');
	if (viewBtn) {
	  viewBtn.style.display = 'none';
	  viewBtn.disabled = true;
	}

	const uploadBtn = $('uploadJiraBtn');
	if (uploadBtn) {
	  uploadBtn.style.display = 'none';
	  uploadBtn.disabled = false;              // ✅ re-enable for next batch
	  uploadBtn.textContent = '📤 Upload to Jira'; // ✅ restore label
	}
  }

  function wireEvents() {
    document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => showSection(item.dataset.section)));

    $('settingsBtn')?.addEventListener('click', () => showSection('settings'));
    $('uploadExcelBtn')?.addEventListener('click', () => showSection('upload'));
    $('setupConfigBtn')?.addEventListener('click', () => showSection('settings'));
	
	$('viewJiraBtn')?.addEventListener('click', async () => {
	  if (!lastCreatedJiraUrl) {
		showToast('⚠️ Jira URL not available', 'warning', 3000);
		return;
	  }

	  await window.api.shell.openExternal(lastCreatedJiraUrl);
	});	

    $('providerType')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      currentConfig.provider = provider;
      showProviderConfig(provider);
      updateStatus();
    });

    $('saveConfigBtn')?.addEventListener('click', saveConfiguration);

	$('testAiBtn')?.addEventListener('click', async () => {
	  try {
		const provider = $('providerType')?.value || 'openai';

		let config = {};

		if (provider === 'openai') {
		  config = {
			apiKey: $('openaiKey')?.value,
			model: $('openaiModel')?.value
		  };
		} else if (provider === 'azure') {
		  config = {
			endpoint: $('azureEndpoint')?.value,
			apiKey: $('azureKey')?.value,
			deployment: $('azureDeployment')?.value,
			apiVersion: $('azureApiVersion')?.value
		  };
		} else if (provider === 'gemini') {
		  config = {
			apiKey: $('geminiKey')?.value,
			model: $('geminiModel')?.value
		  };
		} else if (provider === 'local') {
		  config = {
			endpoint: $('localEndpoint')?.value
		  };
		}

		const result = await window.api.ai.testProvider(provider, config);

		const resultBox = $('aiTestResult');

		if (result.ok) {
		  //resultBox.className = "test-result show success";
		  //resultBox.textContent = "✅ AI Provider Connected Successfully";
		  showToast("✅ AI connection successful", "success");
		} else {
		  //resultBox.className = "test-result show error";
		  //resultBox.textContent = `❌ ${result.error}`;
		  showToast(`❌ ${result.error}`, "error");
		}

	  } catch (e) {
		showToast(`❌ Test failed: ${e.message}`, "error");
	  }
	});

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

    // ✅ Single SFD buttons near Export CSV
    $('sfdViewWbsBtn')?.addEventListener('click', () => {
      if (sfdFinalRow) openDetailModal('wbs', sfdFinalRow);
      else showToast('⚠️ Final row not available yet', 'warning', 3000);
    });

    $('sfdViewOverallReasonBtn')?.addEventListener('click', () => {
      if (sfdFinalRow) openDetailModal('reason', sfdFinalRow);
      else showToast('⚠️ Final row not available yet', 'warning', 3000);
    });

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

    // Row-level view buttons
    $('resultsTableBody')?.addEventListener('click', (e) => {
      const viewBtn = e.target?.closest?.('.view-btn');
      if (!viewBtn) return;

      const action = viewBtn.dataset.action;
      const idx = Number(viewBtn.dataset.idx);

      // SFD table index refers to activityRows order, not estimationResults index.
      if (currentMode === 'sfd' && viewBtn.dataset.sfd === '1') {
        const activityRows = (estimationResults || []).filter((r) => r && isSfdActivityRow(r));
        const row = activityRows[idx];
        if (!row) return;
        if (action === 'view-reason') openDetailModal('reason', row);
        return;
      }

      const row = (estimationResults || [])[idx];
      if (!row) return;

      if (action === 'view-wbs') openDetailModal('wbs', row);
      if (action === 'view-reason') openDetailModal('reason', row);
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
// - XLSX High Level Estimation (unchanged logic)
