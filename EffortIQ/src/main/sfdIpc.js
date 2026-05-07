'use strict';
// src/main/sfdIpc.js
const { ipcMain, dialog } = require('electron');
const { parseSfd, extractActivitiesHeuristic, classifyActivities, estimateActivities, detectRequirementSections } = require('../services/sfd');
let registered = false;

function normalizeErr(e, fallback='Operation failed'){ return e?.message || e?.toString?.() || fallback; }

function registerSfdIpcHandlers(mainWindow){

  if (registered) {
    return; // ✅ prevent double registration
  }

  registered = true;

  ipcMain.handle('sfd:browse', async ()=>{
    try{
      const res = await dialog.showOpenDialog(mainWindow,{
        title:'Select SFD document',
        properties:['openFile'],
        filters:[{name:'Documents',extensions:['pdf','docx','txt','md']},{name:'All Files',extensions:['*']}]
      });
      if(res.canceled) return {ok:false,error:'Selection cancelled'};
      const filePath = res.filePaths?.[0];
      if(!filePath) return {ok:false,error:'No file selected'};
      return {ok:true,filePath};
    }catch(e){ return {ok:false,error:normalizeErr(e,'Failed to browse')}; }
  });

  ipcMain.handle('sfd:parse', async (_e,filePath)=>{
    try{ const res = await parseSfd(filePath); return res.ok ? {ok:true,data:res} : {ok:false,error:res.error,hint:res.hint,meta:res.meta}; }
    catch(e){ return {ok:false,error:normalizeErr(e,'Failed to parse SFD')}; }
  });

  ipcMain.handle('sfd:extract', async (_e,text,options={})=>{
    try{ const res = extractActivitiesHeuristic(text, options||{}); return {ok:true,data:res}; }
    catch(e){ return {ok:false,error:normalizeErr(e,'Failed to extract')}; }
  });

  ipcMain.handle('sfd:classify', async (_e,activities,provider,providerConfig,options={})=>{
    try{ const res = await classifyActivities(activities, provider, providerConfig, options||{}); return {ok:true,data:res}; }
    catch(e){ return {ok:false,error:normalizeErr(e,'Failed to classify')}; }
  });

  ipcMain.handle('sfd:estimate', async (_e,activities)=>{
    try{ const res = estimateActivities(activities||[]); return {ok:true,data:res}; }
    catch(e){ return {ok:false,error:normalizeErr(e,'Failed to estimate')}; }
  });

  ipcMain.handle('sfd:detectRequirementSections', async (_e,headings,provider,providerConfig,options={})=>{
    try{ const res = await detectRequirementSections(headings, provider, providerConfig, options||{}); return res.ok ? {ok:true,data:res} : {ok:false,error:res.error||'AI section detection failed'}; }
    catch(e){ return {ok:false,error:normalizeErr(e,'AI section detection failed')}; }
  });
}

module.exports = { registerSfdIpcHandlers };