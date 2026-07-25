/*
 * electron/main.js — minimal Electron main process for Structural Sandbox.
 * Single window, loads the fully static public/index.html from disk.
 * The page needs no Node APIs (contextIsolation default, nodeIntegration off).
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#101418',
    title: 'Structural Sandbox',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
}

app.whenReady().then(function () {
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  app.quit();
});
