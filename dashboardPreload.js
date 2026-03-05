/**
 * Dashboard Dashboard Preload Script
 * Provides secure IPC bridge for Dashboard window
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose secure API to Dashboard window
contextBridge.exposeInMainWorld('dashboardAPI', {
  // Request initial agents
  getInitialAgents: () => {
    ipcRenderer.send('get-dashboard-agents');
    return new Promise(resolve => {
      const listener = (event, data) => {
        ipcRenderer.removeListener('dashboard-agents-response', listener);
        resolve(data);
      };
      ipcRenderer.on('dashboard-agents-response', listener);
    });
  },

  // Get auth token (legacy, not used anymore)
  getAuthToken: () => '',

  // Get source (legacy, not used anymore)
  getSource: () => 'pixel-agent-desk',

  // Listen for initial data
  onInitialData: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('dashboard-initial-data', listener);
    return () => ipcRenderer.removeListener('dashboard-initial-data', listener);
  },

  // Agent event listeners
  onAgentAdded: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('dashboard-agent-added', listener);
    return () => ipcRenderer.removeListener('dashboard-agent-added', listener);
  },

  onAgentUpdated: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('dashboard-agent-updated', listener);
    return () => ipcRenderer.removeListener('dashboard-agent-updated', listener);
  },

  onAgentRemoved: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('dashboard-agent-removed', listener);
    return () => ipcRenderer.removeListener('dashboard-agent-removed', listener);
  },

  // Send commands to Pixel Agent Desk
  focusAgent: (agentId) => {
    console.log('[DashboardAPI] Focusing agent:', agentId);
    ipcRenderer.send('dashboard-focus-agent', agentId);
  },

  dismissAgent: (agentId) => {
    console.log('[DashboardAPI] Dismissing agent:', agentId);
    ipcRenderer.send('dashboard-dismiss-agent', agentId);
  }
});

console.log('[DashboardPreload] Initialized');
