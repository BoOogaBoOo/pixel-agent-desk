/**
 * JSONL Log Parser
 * Parses Claude CLI JSONL log files to extract agent information and state
 * P0-1: tailFile() uses reverse-read to avoid loading entire large files
 * P2-8: getAgentId() aligned with agentManager (sessionId first)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { formatSlugToDisplayName, safeStatSync, safeExistsSync } = require('./utils');

class JsonlParser {
  constructor() {
    // State system
    this.STATES = {
      WORKING: 'Working',
      THINKING: 'Thinking', // 고민 중
      DONE: 'Done',         // 완료
      ERROR: 'Error',
      HELP: 'Help',         // 알림/도구권한/텍스트응답
      OFFLINE: 'Offline',
      WAITING: 'Waiting'    // 대기 중 (앉아 있는 포즈)
    };
  }

  /**
   * Parse a single JSONL line
   * @param {string} line - JSON string line
   * @returns {Object|null} Parsed data or null if invalid
   */
  parseLine(line) {
    try {
      const data = JSON.parse(line);
      return {
        sessionId: data.sessionId,
        agentId: data.agentId,
        slug: data.slug,
        projectPath: data.cwd,
        type: data.type,
        subtype: data.subtype,
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
        uuid: data.uuid,
        parentUuid: data.parentUuid,
        isSidechain: data.isSidechain,
        userType: data.userType,
        message: data.message,
        toolUseResult: data.toolUseResult,
        durationMs: data.durationMs
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Determine agent state from parsed log entry
   * Simplified: Only Done when truly done, Working otherwise
   */
  determineState(entry) {
    if (!entry) return this.STATES.DONE;
    const { message, type, subtype } = entry;

    // DEBUG LOG
    const stopReason = message?.stop_reason;
    console.log(`[JsonlParser] determineState: type=${type}, subtype=${subtype}, stop_reason=${stopReason}`);

    // 1. Error (명시적 에러만)
    if (type === 'error' || message?.error) {
      console.log(`[JsonlParser] -> ERROR`);
      return this.STATES.ERROR;
    }

    // 2. Done (진짜 끝났을 때만) - 턴이 완전히 끝난 경우
    if (stopReason === 'end_turn' || subtype === 'turn_duration' || subtype === 'Stop') {
      console.log(`[JsonlParser] -> DONE (stop_reason=${stopReason})`);
      return this.STATES.DONE;
    }

    // 3. Working (진행 중) - 그 외 모든 활동 상태
    if (type === 'user' || type === 'assistant' || type === 'progress') {
      console.log(`[JsonlParser] -> WORKING (type=${type})`);
      return this.STATES.WORKING;
    }

    // Hook 이벤트들도 대부분 Working 상태
    if (subtype && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'].includes(subtype)) {
      console.log(`[JsonlParser] -> WORKING (subtype=${subtype})`);
      return this.STATES.WORKING;
    }

    // 초기/종료 상태는 Waiting (앉아 있는 포즈)
    if (subtype && ['SessionStart', 'Idle', 'SessionEnd'].includes(subtype)) {
      console.log(`[JsonlParser] -> WAITING (subtype=${subtype})`);
      return this.STATES.WAITING;
    }

    // 그 외는 Working 기본값
    console.log(`[JsonlParser] -> WORKING (default)`);
    return this.STATES.WORKING;
  }

  /**
   * Extract thinking time from entry
   */
  extractThinkingTime(entry) {
    if (entry.message && entry.message.thinking) {
      if (entry.message.thinking.time_seconds) {
        return entry.message.thinking.time_seconds;
      }
      if (entry.timestamp) {
        return Math.floor((Date.now() - entry.timestamp.getTime()) / 1000);
      }
    }
    return null;
  }

  /**
   * Extract text content from Reporting state
   */
  extractTextContent(entry) {
    // Try content array first
    if (entry.message && entry.message.content) {
      const content = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
      const textBlock = content.find(c => c.type === 'text');
      if (textBlock && textBlock.text) {
        const text = textBlock.text;
        return text.length > 100 ? text.substring(0, 100) + '...' : text;
      }
    }
    // Legacy flat field
    if (entry.message && entry.message.text) {
      const text = entry.message.text;
      return text.length > 100 ? text.substring(0, 100) + '...' : text;
    }
    return '';
  }

  /**
   * Get agent ID - sessionId is the stable key (P2-8: aligned with agentManager)
   * @param {Object} entry - Parsed log entry
   * @returns {string} Unique agent identifier
   */
  getAgentId(entry) {
    return entry.sessionId || entry.agentId || entry.slug || 'unknown-agent';
  }

  /**
   * Read last N lines from a JSONL file using reverse-read (P0-1)
   * Reads only a small chunk from the end of the file instead of the entire file.
   * @param {string} filePath - Path to JSONL file
   * @param {number} maxLines - Max number of lines to return
   * @returns {Array} Array of parsed entries
   */
  tailFile(filePath, maxLines = 100) {
    try {
      if (!safeExistsSync(filePath)) return [];

      const stats = safeStatSync(filePath);
      if (!stats || stats.size === 0) return [];

      const fileSize = stats.size;

      // Read from end — 32KB covers ~100 typical JSONL lines comfortably
      const READ_CHUNK = 32768;
      const readSize = Math.min(fileSize, READ_CHUNK);
      const readStart = fileSize - readSize;

      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, readSize, readStart);
      fs.closeSync(fd);

      const content = buffer.toString('utf-8');

      // If we didn't read from the start, the first line may be incomplete — drop it
      const lines = content.split('\n');
      const validLines = readStart > 0 ? lines.slice(1) : lines;

      return validLines
        .filter(l => l.trim())
        .slice(-maxLines)
        .map(line => this.parseLine(line))
        .filter(entry => entry !== null);
    } catch (error) {
      console.error(`[JsonlParser] Error reading file ${filePath}:`, error.message);
      return [];
    }
  }

  /**
   * Find JSONL files modified within windowMs (active sessions only)
   * @param {number} windowMs - Recency threshold (default: 30 minutes)
   * @returns {Array} Array of file info objects
   */
  findJsonlFiles(windowMs = 30 * 60 * 1000) {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const jsonlFiles = [];
    const cutoff = Date.now() - windowMs;

    try {
      if (!fs.existsSync(projectsDir)) {
        console.log(`[JsonlParser] Projects directory not found: ${projectsDir}`);
        return jsonlFiles;
      }

      const projects = fs.readdirSync(projectsDir, { withFileTypes: true });

      for (const project of projects) {
        if (!project.isDirectory()) continue;

        const projectPath = path.join(projectsDir, project.name);

        // Subagent JSONL files
        const subagentsDir = path.join(projectPath, 'subagents');
        if (fs.existsSync(subagentsDir)) {
          const subagents = fs.readdirSync(subagentsDir, { withFileTypes: true });
          for (const subagent of subagents) {
            if (!subagent.isDirectory()) continue;
            const subagentPath = path.join(subagentsDir, subagent.name);
            for (const file of fs.readdirSync(subagentPath)) {
              if (file.match(/^agent-.*\.jsonl$/)) {
                const filePath = path.join(subagentPath, file);
                if (fs.statSync(filePath).mtimeMs >= cutoff) {
                  jsonlFiles.push({ path: filePath, project: project.name, subagent: subagent.name, filename: file });
                }
              }
            }
          }
        }

        // Session-level JSONL files
        for (const file of fs.readdirSync(projectPath)) {
          if (file.endsWith('.jsonl')) {
            const filePath = path.join(projectPath, file);
            if (fs.statSync(filePath).mtimeMs >= cutoff) {
              jsonlFiles.push({ path: filePath, project: project.name, subagent: null, filename: file });
            }
          }
        }
      }

      console.log(`[JsonlParser] Found ${jsonlFiles.length} active JSONL files (within ${windowMs / 60000}min)`);
      return jsonlFiles;
    } catch (error) {
      console.error('[JsonlParser] Error scanning projects directory:', error.message);
      return jsonlFiles;
    }
  }

  /**
   * Get file modification time
   */
  getFileModTime(filePath) {
    try {
      return fs.statSync(filePath).mtime;
    } catch (error) {
      return new Date(0);
    }
  }
}

module.exports = JsonlParser;
