# EffortIQ – SFD Extension Integration (Patch Notes)

This package adds a new folder:

```
src/services/sfd/
```

## 1) Install optional dependencies

For parsing:

- PDF: `npm i pdf-parse`
- DOCX: `npm i mammoth`

## 2) Main process IPC wiring (src/main/index.js)

Your current main process registers IPC handlers for Excel, Config, Estimate, Jira. See <File>index.js</File>. citeturn2search16

Add these requires near the top:

```js
const { parseSfd, extractActivitiesHeuristic, classifyActivities, estimateActivities, indexLocalSource, suggestFilesForActivity } = require('../services/sfd');
```

Add IPC handlers:

```js
ipcMain.handle('sfd:parse', async (_event, filePath) => {
  const res = await parseSfd(filePath);
  return res.ok ? { ok: true, data: res } : { ok: false, error: res.error };
});

ipcMain.handle('sfd:extract', async (_event, text, options) => {
  const res = extractActivitiesHeuristic(text, options || {});
  return { ok: true, data: res };
});

ipcMain.handle('sfd:classify', async (_event, activities, provider, providerConfig, options) => {
  const res = await classifyActivities(activities, provider, providerConfig, options || {});
  return { ok: true, data: res };
});

ipcMain.handle('sfd:estimate', async (_event, activities) => {
  const res = estimateActivities(activities);
  return { ok: true, data: res };
});

ipcMain.handle('sfd:sourceIndex', async (_event, opts) => {
  const res = indexLocalSource(opts || {});
  return { ok: true, data: res };
});

ipcMain.handle('sfd:suggestFiles', async (_event, activity, sourceIndex) => {
  const res = suggestFilesForActivity(activity, sourceIndex);
  return { ok: true, data: res };
});
```

## 3) Preload bridge (src/main/preload.js)

Your current bridge exposes Excel/Config/Estimate/Jira/Shell. See <File>preload.js</File>. citeturn4search25

Add:

```js
sfd: {
  parse: (filePath) => invoke('sfd:parse', filePath),
  extract: (text, options) => invoke('sfd:extract', text, options),
  classify: (activities, provider, providerConfig, options) => invoke('sfd:classify', activities, provider, providerConfig, options),
  estimate: (activities) => invoke('sfd:estimate', activities),
  sourceIndex: (opts) => invoke('sfd:sourceIndex', opts),
  suggestFiles: (activity, sourceIndex) => invoke('sfd:suggestFiles', activity, sourceIndex),
},
```

## 4) UI tab wiring (renderer/index.html + renderer.js)

Your <File>index.html</File> currently has tabs for Dashboard/Upload/Settings/About. citeturn4search52

Add a new nav item and section (SFD Estimation). Then wire events in renderer to call `window.api.sfd.*`.

---

If you want, I can generate the updated UI files too (index.html, renderer.js, styles.css) in the same premium PowerBI-like style.
