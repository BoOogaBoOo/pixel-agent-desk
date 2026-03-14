/**
 * Hook Event Processor
 * processHookEvent() switch statement + handleSessionStart/End + cleanupAgentResources
 */

const path = require('path');
const { MODEL_PRICING, DEFAULT_PRICING, roundCost, getContextWindowSize } = require('../pricing');

/**
 * Calculate updated token usage from a PostToolUse tool_response.
 * @returns {object|null} Updated tokenUsage object, or null if no usage data.
 */
function computeTokenUsage(agent, tokenUsage) {
  if (!tokenUsage) return null;
  const cur = agent.tokenUsage || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  const inputTokens = cur.inputTokens + (tokenUsage.input_tokens || 0);
  const outputTokens = cur.outputTokens + (tokenUsage.output_tokens || 0);
  const pricing = MODEL_PRICING[agent.model] || DEFAULT_PRICING;
  const estimatedCost = inputTokens * pricing.input + outputTokens * pricing.output;
  const ctxWindow = getContextWindowSize(agent.model);
  const latestInput = tokenUsage.input_tokens || 0;
  const contextPercent = ctxWindow > 0 ? Math.min(100, Math.round((latestInput / ctxWindow) * 100)) : 0;
  return { inputTokens, outputTokens, estimatedCost: roundCost(estimatedCost), contextPercent };
}

/**
 * Attempt PID reconnection via transcript when an `echo $$` / `echo $PPID` is detected.
 */
function handlePidReconnect({ agentManager, sessionPids, sessionId, data, debugLog, detectClaudePidByTranscript }) {
  if (data.tool_name !== 'Bash' || !data.tool_input) return;
  if (!/echo\s+\$(\$|PPID)/.test(data.tool_input.command || '')) return;

  const agent = agentManager && agentManager.getAgent(sessionId);
  const jsonlPath = (agent && agent.jsonlPath) || data.transcript_path || null;
  debugLog(`[Hook] PID reconnect trigger: ${sessionId.slice(0, 8)} (echo detected)`);

  if (agent && !sessionPids.has(sessionId)) {
    agentManager.updateAgent({ ...agent, firstSeen: Date.now() }, 'hook');
  }
  detectClaudePidByTranscript(jsonlPath, (result) => {
    if (typeof result === 'number') {
      sessionPids.set(sessionId, result);
      debugLog(`[Hook] PID reconnected: ${sessionId.slice(0, 8)} -> pid=${result}`);
    } else if (Array.isArray(result)) {
      const registeredPids = new Set(sessionPids.values());
      const newPid = result.find(p => !registeredPids.has(p));
      if (newPid) {
        sessionPids.set(sessionId, newPid);
        debugLog(`[Hook] PID reconnected (fallback): ${sessionId.slice(0, 8)} -> pid=${newPid}`);
      }
    }
  });
}

// ─── Background Task Detection ───
const BG_BASH_PATTERNS = [
  /(?:^|[^&])\s*&\s*$/m,     // trailing & (not &&)
  /\bnohup\b/,
  /\bdisown\b/,
  /\bsetsid\b/,
  /\bscreen\s+-[dS]/,
  />\s*\/dev\/null\s+2>&1\s*&/,
];
const BG_PID_PATTERNS = [/\[\d+\]\s+\d+/, /nohup:.*appending/];
const BG_STOP_HINTS = [
  /\bbackground\b/i, /\brunning\b.*\b(script|process|task|pipeline)\b/i,
  /\bkicked off\b/i, /\bin the background\b/i, /\bovernight\b/i,
];
const BG_DECAY_MS = 2 * 60 * 60 * 1000; // 2 hours

class BackgroundTaskTracker {
  constructor() { this.sessions = new Map(); }

  _get(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { openSubagents: new Set(), bgBashCount: 0, bgBashLastAt: 0, taskOutputSeen: false, stopHints: false });
    }
    return this.sessions.get(sessionId);
  }

  onPreToolUse(sessionId, toolName, toolInput) {
    const s = this._get(sessionId);
    if (toolName === 'Bash') {
      const cmd = (typeof toolInput === 'object' && toolInput) ? (toolInput.command || '') : String(toolInput || '');
      const hasBgFlag = typeof toolInput === 'object' && toolInput && toolInput.run_in_background;
      if (hasBgFlag || BG_BASH_PATTERNS.some(p => p.test(cmd))) {
        s.bgBashCount++;
        s.bgBashLastAt = Date.now();
      }
    }
    if (toolName === 'TaskOutput') s.taskOutputSeen = true;
  }

  onPostToolUse(sessionId, toolName, response) {
    if (toolName === 'Bash' && response) {
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      if (BG_PID_PATTERNS.some(p => p.test(text))) {
        const s = this._get(sessionId);
        s.bgBashCount++;
        s.bgBashLastAt = Date.now();
      }
    }
  }

  onSubagentStart(sessionId, subId) {
    this._get(sessionId).openSubagents.add(subId);
  }

  onSubagentStop(sessionId, subId) {
    const s = this.sessions.get(sessionId);
    if (s) s.openSubagents.delete(subId);
  }

  onStop(sessionId, lastMessage) {
    const s = this._get(sessionId);
    s.stopHints = lastMessage ? BG_STOP_HINTS.some(p => p.test(lastMessage)) : false;
  }

  onSessionEnd(sessionId) { this.sessions.delete(sessionId); }

  hasBackgroundWork(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    // Layer 1: open subagents (definitive)
    if (s.openSubagents.size > 0) return true;
    // Layer 2: recent background bash
    const recentBash = s.bgBashCount > 0 && (Date.now() - s.bgBashLastAt) < BG_DECAY_MS;
    // Layer 2b: TaskOutput seen
    const l2Score = (recentBash ? 1 : 0) + (s.taskOutputSeen ? 1 : 0);
    if (l2Score >= 2) return true;
    // Layer 2 + Layer 3 combo
    if (l2Score >= 1 && s.stopHints) return true;
    return false;
  }
}

function createHookProcessor({ agentManager, sessionPids, debugLog, detectClaudePidByTranscript }) {
  // Internal state
  const pendingSessionStarts = [];
  const firstPreToolUseDone = new Map(); // sessionId -> boolean
  const bgTracker = new BackgroundTaskTracker();

  function processHookEvent(data) {
    const event = data.hook_event_name;
    const sessionId = data.session_id || data.sessionId;
    if (!sessionId) return;

    debugLog(`[Hook] ${event} session=${sessionId.slice(0, 8)}`);

    // Create agent immediately on first event even if SessionStart was missed (universal fallback)
    if (agentManager && event !== 'SessionStart' && event !== 'SessionEnd') {
      const existing = agentManager.getAgent(sessionId);
      if (!existing) {
        debugLog(`[Hook] Auto-create from ${event}: ${sessionId.slice(0, 8)}`);
        handleSessionStart(sessionId, data.cwd || '', 0, false, false, 'Waiting', null, {
          jsonlPath: data.transcript_path || null,
          model: data.model || null,
          permissionMode: data.permission_mode || null,
        });
      }
    }

    switch (event) {
      case 'SessionStart': {
        const sessionSource = data.source || 'startup';
        const sessionMeta = {
          jsonlPath: data.transcript_path || null,
          model: data.model || null,
          permissionMode: data.permission_mode || null,
          source: sessionSource,
          agentType: data.agent_type || null,
        };

        // compact/resume/clear: only update if existing agent found (prevent duplicate creation)
        if (sessionSource !== 'startup' && agentManager) {
          const existing = agentManager.getAgent(sessionId);
          if (existing) {
            const compactUpdate = {
              ...existing, sessionId, state: 'Waiting',
              jsonlPath: sessionMeta.jsonlPath || existing.jsonlPath,
              model: sessionMeta.model || existing.model,
              source: sessionSource,
            };
            if (sessionSource === 'compact') {
              compactUpdate.tokenUsage = { ...(existing.tokenUsage || {}), contextPercent: 0 };
            }
            agentManager.updateAgent(compactUpdate, 'hook');
            debugLog(`[Hook] SessionStart (${sessionSource}) → updated existing agent ${sessionId.slice(0, 8)}`);
            break;
          }
        }

        handleSessionStart(sessionId, data.cwd || '', data._pid || 0, false, false, 'Waiting', null, sessionMeta);
        break;
      }

      case 'SessionEnd':
        if (data.reason) {
          debugLog(`[Hook] SessionEnd reason: ${data.reason} for ${sessionId.slice(0, 8)}`);
        }
        handleSessionEnd(sessionId);
        break;

      case 'UserPromptSubmit':
        firstPreToolUseDone.delete(sessionId);
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) {
            agentManager.updateAgent({ ...agent, sessionId, state: 'Thinking' }, 'hook');
          }
        }
        break;

      case 'Stop': {
        // Stop = agent finished current turn, session still alive (waiting for next prompt)
        firstPreToolUseDone.delete(sessionId);
        bgTracker.onStop(sessionId, data.last_assistant_message || null);
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          const lastMsg = data.last_assistant_message || null;
          const hasBg = bgTracker.hasBackgroundWork(sessionId);
          if (agent) {
            agentManager.updateAgent({ ...agent, sessionId, state: 'Waiting', currentTool: null, lastMessage: lastMsg, hasBackgroundWork: hasBg }, 'hook');
          }
        }
        break;
      }

      case 'TaskCompleted': {
        firstPreToolUseDone.delete(sessionId);
        if (data.task_id) {
          debugLog(`[Hook] TaskCompleted: task=${data.task_id} subject="${data.task_subject || ''}" by ${data.teammate_name || sessionId.slice(0, 8)}`);
        }
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          const lastMsg = data.last_assistant_message || null;
          if (agent) {
            agentManager.updateAgent({ ...agent, sessionId, state: 'Done', currentTool: null, lastMessage: lastMsg }, 'hook');
          }
        }
        break;
      }

      case 'PreToolUse': {
        if (!firstPreToolUseDone.has(sessionId)) {
          firstPreToolUseDone.set(sessionId, true);
          debugLog(`[Hook] PreToolUse ignored (first = session init)`);
        } else if (agentManager) {
          bgTracker.onPreToolUse(sessionId, data.tool_name, data.tool_input);
          const agent = agentManager.getAgent(sessionId);
          if (agent) {
            agentManager.updateAgent({ ...agent, sessionId, state: 'Working', currentTool: data.tool_name || null }, 'hook');
          }
        }
        break;
      }

      case 'PostToolUse': {
        if (agentManager && firstPreToolUseDone.has(sessionId)) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) {
            const rawUsage = data.tool_response && data.tool_response.token_usage;
            const updatedUsage = computeTokenUsage(agent, rawUsage);
            agentManager.updateAgent({
              ...agent, sessionId, state: 'Thinking', currentTool: null,
              ...(updatedUsage && { tokenUsage: updatedUsage })
            }, 'hook');
          }
        }

        bgTracker.onPostToolUse(sessionId, data.tool_name, data.tool_response);
        handlePidReconnect({ agentManager, sessionPids, sessionId, data, debugLog, detectClaudePidByTranscript });
        break;
      }

      case 'PostToolUseFailure':
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Error', currentTool: data.tool_name || null }, 'hook');
        }
        break;

      case 'PermissionRequest':
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Help', currentTool: data.tool_name || null }, 'hook');
        }
        break;

      case 'Notification': {
        const notifType = data.notification_type;
        let notifState = 'Waiting';
        if (notifType === 'permission_prompt' || notifType === 'elicitation_dialog') {
          notifState = 'Help';
        }

        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) agentManager.updateAgent({ ...agent, sessionId, state: notifState }, 'hook');
        }
        break;
      }

      case 'SubagentStart': {
        const subId = data.agent_id || data.subagent_session_id;
        if (subId) {
          bgTracker.onSubagentStart(sessionId, subId);
          handleSessionStart(subId, data.cwd || '', 0, false, true, 'Working', sessionId, {
            jsonlPath: data.agent_transcript_path || data.transcript_path || null,
            agentType: data.agent_type || null,
          });
          debugLog(`[Hook] SubagentStart: ${subId.slice(0, 8)} type=${data.agent_type || 'unknown'} parent=${sessionId.slice(0, 8)}`);
        }
        break;
      }

      case 'SubagentStop': {
        const subId = data.agent_id || data.subagent_session_id;
        if (subId) {
          bgTracker.onSubagentStop(sessionId, subId);
          if (data.last_assistant_message && agentManager) {
            const subAgent = agentManager.getAgent(subId);
            if (subAgent) {
              agentManager.updateAgent({ ...subAgent, lastMessage: data.last_assistant_message, state: 'Done' }, 'hook');
            }
          }
          handleSessionEnd(subId);
        }
        break;
      }

      case 'TeammateIdle': {
        const teammateName = data.teammate_name || null;
        const teamName = data.team_name || null;
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) {
            agentManager.updateAgent({
              ...agent, state: 'Waiting', isTeammate: true,
              teammateName, teamName, currentTool: null
            }, 'hook');
          } else {
            handleSessionStart(sessionId, data.cwd || '', 0, true, false, 'Waiting', null, {
              jsonlPath: data.transcript_path || null,
              teammateName, teamName,
            });
          }
        }
        debugLog(`[Hook] TeammateIdle: ${sessionId.slice(0, 8)} name=${teammateName} team=${teamName}`);
        break;
      }

      case 'PreCompact': {
        const trigger = data.trigger || 'unknown';
        debugLog(`[Hook] PreCompact (${trigger}) for ${sessionId.slice(0, 8)}`);
        if (agentManager) {
          const agent = agentManager.getAgent(sessionId);
          if (agent) {
            // Reset firstSeen to extend liveness grace period during compact
            agentManager.updateAgent({ ...agent, sessionId, state: 'Thinking', firstSeen: Date.now() }, 'hook');
          }
        }
        break;
      }

      case 'ConfigChange':
      case 'WorktreeCreate':
      case 'WorktreeRemove':
        debugLog(`[Hook] Meta info: ${event} for ${sessionId.slice(0, 8)}`);
        break;

      default:
        debugLog(`[Hook] Unknown: ${event} — ${JSON.stringify(data).slice(0, 150)}`);
    }
  }

  function handleSessionStart(sessionId, cwd, pid = 0, isTeammate = false, isSubagent = false, initialState = 'Waiting', parentId = null, meta = {}) {
    if (!agentManager) {
      pendingSessionStarts.push({ sessionId, cwd, ts: Date.now(), isTeammate, isSubagent, initialState, parentId, meta });
      debugLog(`[Hook] SessionStart queued: ${sessionId.slice(0, 8)}`);
      return;
    }
    const displayName = cwd ? path.basename(cwd) : 'Agent';
    agentManager.updateAgent({
      sessionId, projectPath: cwd, displayName, state: initialState,
      jsonlPath: meta.jsonlPath || null,
      model: meta.model || null,
      permissionMode: meta.permissionMode || null,
      source: meta.source || null,
      agentType: meta.agentType || null,
      teammateName: meta.teammateName || null,
      teamName: meta.teamName || null,
      isTeammate, isSubagent, parentId
    }, 'http');
    debugLog(`[Hook] SessionStart → agent: ${sessionId.slice(0, 8)} (${displayName}) ${isTeammate ? '[Team]' : ''} ${isSubagent ? '[Sub]' : ''} (Parent: ${parentId ? parentId.slice(0, 8) : 'none'})`);

    if (pid > 0) {
      sessionPids.set(sessionId, pid);
      return;
    }
    detectClaudePidByTranscript(meta.jsonlPath || null, (result) => {
      if (!result) return;
      if (typeof result === 'number') {
        sessionPids.set(sessionId, result);
        debugLog(`[Hook] SessionStart PID via transcript: ${sessionId.slice(0, 8)} → pid=${result}`);
      } else if (Array.isArray(result)) {
        const registeredPids = new Set(sessionPids.values());
        const newPid = result.find(p => !registeredPids.has(p));
        if (newPid) {
          sessionPids.set(sessionId, newPid);
          debugLog(`[Hook] SessionStart PID via fallback: ${sessionId.slice(0, 8)} → pid=${newPid}`);
        }
      }
    });
  }

  function cleanupAgentResources(sessionId) {
    firstPreToolUseDone.delete(sessionId);
    sessionPids.delete(sessionId);
    bgTracker.onSessionEnd(sessionId);
    debugLog(`[Cleanup] Resources cleared for ${sessionId.slice(0, 8)}`);
  }

  function handleSessionEnd(sessionId) {
    cleanupAgentResources(sessionId);

    if (!agentManager) return;
    const agent = agentManager.getAgent(sessionId);
    if (agent) {
      debugLog(`[Hook] SessionEnd → removing agent ${sessionId.slice(0, 8)}`);
      agentManager.removeAgent(sessionId);
    } else {
      debugLog(`[Hook] SessionEnd for unknown agent ${sessionId.slice(0, 8)}`);
    }
  }

  function flushPendingStarts() {
    while (pendingSessionStarts.length > 0) {
      const { sessionId, cwd, isTeammate, isSubagent, initialState, parentId, meta } = pendingSessionStarts.shift();
      handleSessionStart(sessionId, cwd, 0, isTeammate, isSubagent, initialState || 'Waiting', parentId, meta || {});
    }
  }

  function cleanup() {
    firstPreToolUseDone.clear();
    pendingSessionStarts.length = 0;
  }

  return {
    processHookEvent,
    handleSessionStart,
    handleSessionEnd,
    flushPendingStarts,
    cleanup,
    // expose for sessionPersistence
    get firstPreToolUseDone() { return firstPreToolUseDone; },
  };
}

module.exports = { createHookProcessor };
