/**
 * Log File Monitoring Module
 * P0-2: Initial load sends only last state per sessionId (not all 100 entries)
 * P0-3: pendingBuffer handles split lines at chunk boundaries
 * P2-11: Removed dead event forwarding (main.js directly listens to agentManager)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const JsonlParser = require('./jsonlParser');
const AgentManager = require('./agentManager');
const ProcessWatcher = require('./processWatcher');

class LogMonitor {
  constructor(agentManager = null) {
    this.parser = new JsonlParser();
    this.agentManager = agentManager || new AgentManager();
    this.processWatcher = new ProcessWatcher();
    this.watchedFiles = new Map(); // filePath -> { watcher, lastSize, pendingBuffer }
    this.scanIntervalHandle = null;
    this.scanInterval = 5000; // Scan for NEW files every 5 seconds
  }

  /**
   * Start monitoring JSONL files
   */
  start() {
    // Start agent manager cleanup interval
    this.agentManager.start();

    // Initial scan
    this.discoverAndWatchFiles();

    // Periodic scan for new files
    this.scanIntervalHandle = setInterval(() => {
      this.discoverAndWatchFiles();
    }, this.scanInterval);

    console.log('[LogMonitor] Started (fs.watch + incremental + pendingBuffer)');
  }

  /**
   * Discover new JSONL files and set up watchers
   */
  discoverAndWatchFiles() {
    const jsonlFiles = this.parser.findJsonlFiles();
    for (const fileInfo of jsonlFiles) {
      if (!this.watchedFiles.has(fileInfo.path)) {
        this.initialReadAndWatch(fileInfo);
      }
    }
  }

  /**
   * Initial tail read — collect all entries, send only last state per session
   */
  async initialReadAndWatch(fileInfo) {
    const filePath = fileInfo.path;
    const projectPath = fileInfo.project;
    const RECENT_MS = 30 * 60 * 1000;
    const cutoff = Date.now() - RECENT_MS;

    try {
      const entries = this.parser.tailFile(filePath, 100);

      // Collect last state per sessionId (don't spam updateAgent for every line)
      const lastBySession = new Map();
      for (const entry of entries) {
        if (!entry.sessionId && !entry.agentId) continue;
        const entryTime = entry.timestamp ? entry.timestamp.getTime() : 0;
        if (entryTime < cutoff) continue;

        const sessionKey = entry.sessionId || entry.agentId;
        const state = this.parser.determineState(entry);
        const thinkingTime = this.parser.extractThinkingTime(entry);
        const textContent = this.parser.extractTextContent(entry);

        // Always overwrite — last entry wins (most recent state per session)
        if (entry.subtype === 'SessionEnd') {
          // 세션 종료 이벤트 → 이미 등록된 경우 제거, 신규면 추가 안 함
          lastBySession.delete(sessionKey);
          continue;
        }

        lastBySession.set(sessionKey, {
          ...entry,
          state,
          thinkingTime,
          textContent,
          projectPath,
          jsonlPath: filePath,
          startTime: fileInfo.mtime ? new Date(fileInfo.mtime) : new Date()
        });
      }

      // Reflect actual state from logs
      for (const [, agentData] of lastBySession) {
        if (agentData.state) {
          this.agentManager.updateAgent(agentData, 'log_initial');
        }
      }

      // Record current file size for incremental reading
      let lastSize = 0;
      try {
        lastSize = fs.statSync(filePath).size;
      } catch (e) {
        return; // File deleted between discovery and stat
      }

      // Set up fs.watch for incremental reading
      const watcher = fs.watch(filePath, (event) => {
        if (event === 'change') {
          this.handleFileChange(filePath);
        }
      });

      watcher.on('error', (err) => {
        console.error(`[LogMonitor] Watcher error for ${filePath}:`, err.message);
        this.unwatchFile(filePath);
      });

      this.watchedFiles.set(filePath, {
        watcher,
        lastSize,
        pendingBuffer: '', // P0-3: buffer for incomplete lines
        project: fileInfo.project
      });

      if (lastBySession.size > 0) {
        console.log(`[LogMonitor] Watching: ${path.basename(filePath)} | ${lastBySession.size} session(s)`);
      }

    } catch (error) {
      console.error(`[LogMonitor] Error setting up watch for ${filePath}:`, error.message);
    }
  }

  /**
   * P0-3: Handle file change — read new bytes, handle line boundaries with pendingBuffer
   */
  handleFileChange(filePath) {
    const watched = this.watchedFiles.get(filePath);
    if (!watched) return;

    try {
      const stats = fs.statSync(filePath);
      const newSize = stats.size;

      if (newSize <= watched.lastSize) {
        // File truncated or unchanged
        if (newSize < watched.lastSize) {
          watched.lastSize = newSize;
          watched.pendingBuffer = '';
        }
        return;
      }

      const oldSize = watched.lastSize;
      watched.lastSize = newSize;

      // Read only the new bytes
      const readSize = newSize - oldSize;
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, readSize, oldSize);
      fs.closeSync(fd);

      // Prepend any buffered incomplete line from previous read (P0-3)
      const newContent = watched.pendingBuffer + buffer.toString('utf-8');

      // Find last complete line boundary
      const lastNewline = newContent.lastIndexOf('\n');
      if (lastNewline === -1) {
        // No complete line yet — buffer everything for next read
        watched.pendingBuffer = newContent;
        return;
      }

      // Save the trailing incomplete fragment
      watched.pendingBuffer = newContent.slice(lastNewline + 1);
      const completeContent = newContent.slice(0, lastNewline);

      const lines = completeContent.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const entry = this.parser.parseLine(line);
        if (!entry) continue;
        if (!entry.sessionId && !entry.agentId) continue;

        // SessionEnd 감지 → 즉시 에이전트 제거
        if (entry.subtype === 'SessionEnd') {
          const agentId = entry.sessionId || entry.agentId;
          console.log(`[LogMonitor] SessionEnd detected for ${agentId?.slice(0, 8)}, removing agent`);
          this.agentManager.removeAgent(agentId);
          continue;
        }

        const state = this.parser.determineState(entry);
        const thinkingTime = this.parser.extractThinkingTime(entry);
        const textContent = this.parser.extractTextContent(entry);

        this.agentManager.updateAgent({ ...entry, state, thinkingTime, textContent }, 'log');
      }

    } catch (error) {
      console.error(`[LogMonitor] Error reading changes for ${filePath}:`, error.message);
    }
  }

  /**
   * Stop watching a specific file
   */
  unwatchFile(filePath) {
    const watched = this.watchedFiles.get(filePath);
    if (watched && watched.watcher) {
      watched.watcher.close();
    }
    this.watchedFiles.delete(filePath);
  }

  /**
   * Force refresh all files
   */
  refresh() {
    for (const [, watched] of this.watchedFiles) {
      if (watched.watcher) watched.watcher.close();
    }
    this.watchedFiles.clear();
    this.discoverAndWatchFiles();
    console.log('[LogMonitor] Force refreshed');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.scanIntervalHandle) {
      clearInterval(this.scanIntervalHandle);
      this.scanIntervalHandle = null;
    }
    for (const [, watched] of this.watchedFiles) {
      if (watched.watcher) watched.watcher.close();
    }
    this.watchedFiles.clear();
    this.agentManager.stop();
    console.log('[LogMonitor] Stopped');
  }

  getAllAgents() { return this.agentManager.getAllAgents(); }
  getAgent(agentId) { return this.agentManager.getAgent(agentId); }
  dismissAgent(agentId) { return this.agentManager.dismissAgent(agentId); }
  getStats() { return this.agentManager.getStats(); }
}

module.exports = LogMonitor;
