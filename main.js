const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const AgentManager = require('./agentManager');
const { adaptAgentToDashboard } = require('./dashboardAdapter');
const errorHandler = require('./errorHandler');
const Ajv = require('ajv');
const { getWindowSizeForAgents, checkSessionActive } = require('./utils');

// 에러 로그 파일로 저장
const errorLogPath = path.join(__dirname, 'startup-error.log');
const originalConsoleError = console.error;
console.error = (...args) => {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  // 파일에 저장
  try {
    fs.appendFileSync(errorLogPath, logMessage);
  } catch (e) {}

  // 원래 console.error도 호출
  originalConsoleError.apply(console, args);
};

// 전역 에러 핸들러
process.on('uncaughtException', (error) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n`;
  try {
    fs.appendFileSync(errorLogPath, logMessage);
  } catch (e) {}
});

process.on('unhandledRejection', (reason, promise) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] UNHANDLED REJECTION: ${reason}\n`;
  try {
    fs.appendFileSync(errorLogPath, logMessage);
  } catch (e) {}
});

// Dashboard WebSocket broadcast (사용하지 않음 - 별도 서버 불필요)
function broadcastUpdate(type, data) {
  // 현재는 사용하지 않음. 필요시 구현
}

// Debug logging to file
const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(path.join(__dirname, 'debug.log'), logMsg);
  console.log(msg);
};

let mainWindow;
let agentManager = null;
let keepAliveInterval = null;

function resizeWindowForAgents(agentsOrCount) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width } = getWindowSizeForAgents(agentsOrCount);
  const bounds = mainWindow.getBounds();
  // Only adjust width here, height is managed by DOM observer
  if (width !== bounds.width) {
    mainWindow.setBounds({ ...bounds, width: width });
  }
  const info = Array.isArray(agentsOrCount) ? agentsOrCount.length : agentsOrCount;
  console.log(`[Main] Window width → ${width} (${info} agents based layout)`);
}

// =====================================================
// 윈도우 생성
// =====================================================
ipcMain.on('resize-window', (e, size) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { width, height, y } = mainWindow.getBounds();

    // 렌더러에서 보내온 실측 사이즈 반영 (가로/세로 모두)
    // 약간의 안전 여백(Padding) 부여 및 최소 사이즈 보장
    const newWidth = Math.max(220, Math.ceil(size.width ? size.width + 30 : width));
    const newHeight = Math.max(300, Math.ceil(size.height ? size.height + 40 : height));

    if (newWidth === width && newHeight === height) return;

    // Bottom-anchor logic: calculate Y position change
    const diffHeight = newHeight - height;
    const newY = Math.max(0, y - diffHeight);

    mainWindow.setBounds({
      width: newWidth,
      height: newHeight,
      y: newY
    });

    debugLog(`[Main] IPC Resize → ${newWidth}x${newHeight} (y: ${newY})`);
  }
});

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const winSize = getWindowSizeForAgents(0);

  mainWindow = new BrowserWindow({
    width: winSize.width,
    height: winSize.height,
    x: Math.round((width - winSize.width) / 2),
    y: Math.round((height - winSize.height) / 2),
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true, // programmatic setBounds works better when true
    movable: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');

  // errorHandler에 mainWindow 등록
  errorHandler.setMainWindow(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // 개발자 도구 열기 (디버깅용)
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 작업표시줄 복구 폴링 (250ms)
  startKeepAlive();
}

function startKeepAlive() {
  if (keepAliveInterval) return; // 이미 실행 중이면 중복 생성 방지
  keepAliveInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 250);
  debugLog('[Main] Keep-alive interval started');
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    debugLog('[Main] Keep-alive interval stopped');
  }
}

// =====================================================
// Dashboard Dashboard Window Management
// =====================================================
let dashboardWindow = null;
let dashboardAuthToken = null;

function generateAuthToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    debugLog('[MissionControl] Window already open, focusing existing window');
    dashboardWindow.focus();
    return { success: true, alreadyOpen: true };
  }

  try {
    // Get display dimensions for positioning
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    // Create window with secure settings
    dashboardWindow = new BrowserWindow({
      width: Math.floor(width * 0.8),
      height: Math.floor(height * 0.8),
      x: Math.floor(width * 0.1),
      y: Math.floor(height * 0.1),
      title: '픽셀 에이전트 데스크',
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, 'missionControlPreload.js')
      }
    });

    // Load the HTML file directly (no HTTP server needed)
    dashboardWindow.loadFile('dashboard.html');

    // Log when window is ready
    dashboardWindow.webContents.on('did-finish-load', () => {
      debugLog('[MissionControl] Window loaded successfully');

      // Send initial agent data
      if (agentManager) {
        const agents = agentManager.getAllAgents();
        const adaptedAgents = agents.map(agent => adaptAgentToMissionControl(agent));
        debugLog(`[MissionControl] Sending ${adaptedAgents.length} agents to dashboard`);
        dashboardWindow.webContents.send('dashboard-initial-data', adaptedAgents);
      }
    });

    // Handle navigation errors
    dashboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      debugLog(`[MissionControl] Failed to load: ${errorCode} - ${errorDescription}`);
      dashboardWindow.destroy();
      dashboardWindow = null;
      dashboardAuthToken = null;
    });

    // Clean up when window is closed
    dashboardWindow.on('closed', () => {
      debugLog('[MissionControl] Window closed');
      dashboardWindow = null;
      dashboardAuthToken = null;
    });

    debugLog('[MissionControl] Window created');

    return { success: true };

  } catch (error) {
    debugLog(`[MissionControl] Failed to create window: ${error.message}`);
    dashboardWindow = null;
    dashboardAuthToken = null;
    return { success: false, error: error.message };
  }
}

function closeMissionControlWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.close();
    debugLog('[MissionControl] Window closed by request');
  }
  dashboardWindow = null;
  dashboardAuthToken = null;
}


// =====================================================
// 앱 설정
// ============================================================
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');
process.env.ELECTRON_DISABLE_LOGGING = '1';
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// =====================================================
// Claude CLI 훅 자동 등록 & 프로세스 PID 모니터링
// =====================================================
const HOOK_SERVER_PORT = 47821;

function setupClaudeHooks() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const rawContent = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
        settings = JSON.parse(rawContent);
      } catch (parseErr) {
        debugLog(`[Main] settings.json parse error: ${parseErr.message}. Backing up.`);
        try {
          fs.copyFileSync(settingsPath, settingsPath + '.corrupt_backup');
        } catch (e) {
          errorHandler.capture(e, {
            code: 'E002',
            category: 'FILE_IO',
            severity: 'ERROR'
          });
        }
        settings = {};
      }
    }
    if (!settings.hooks) settings.hooks = {};

    const hookScript = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
    const hookCmd = `node "${hookScript}"`;

    // command 훅으로 모든 이벤트를 hook.js로 전달 (공식 가이드 기준 전체 확장)
    const HOOK_EVENTS = [
      'SessionStart', 'SessionEnd',
      'UserPromptSubmit',           // 사용자 메시지 제출 → Working
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'Stop',                       // Claude 응답 완료 → Done
      'TaskCompleted',
      'PermissionRequest', 'Notification',
      'SubagentStart', 'SubagentStop',
      'TeammateIdle',               // 에이전트 팀 멤버 대기 중 → Waiting
      'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact' // 기타 이벤트
    ];

    for (const eventName of HOOK_EVENTS) {
      let hooks = settings.hooks[eventName] || [];
      // 기존 hook.js 훅 제거 (중복 방지)
      hooks = hooks.filter(c => !c.hooks?.some(h => h.type === 'command' && h.command?.includes('hook.js')));
      // 기존 http 훅도 제거 (Claude CLI가 http 훅을 보내지 않으므로)
      hooks = hooks.filter(c => !c.hooks?.some(h => h.type === 'http' && h.url?.includes(`:${HOOK_SERVER_PORT}`)));
      hooks.push({ matcher: "*", hooks: [{ type: "command", command: hookCmd }] });
      settings.hooks[eventName] = hooks;
    }

    // SessionEnd 추가: JSONL 직접 기록 보험 (강제 종료 직전 sessionend_hook.js 실행)
    const endScript = path.join(__dirname, 'sessionend_hook.js').replace(/\\/g, '/');
    let endHooks = settings.hooks['SessionEnd'] || [];
    endHooks = endHooks.filter(c => !c.hooks?.some(h => h.type === 'command' && h.command?.includes('sessionend_hook')));
    endHooks.push({ matcher: "*", hooks: [{ type: "command", command: `node "${endScript}"` }] });
    settings.hooks['SessionEnd'] = endHooks;

    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 4), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
    debugLog(`[Main] Registered all hooks via hook.js`);
  } catch (e) {
    errorHandler.capture(e, {
      code: 'E006',
      category: 'HOOK_SERVER',
      severity: 'ERROR'
    });
    debugLog(`[Main] Failed to setup hooks: ${e.message}`);
  }
}

// =====================================================
// HTTP 훅 서버 — Claude CLI가 SessionStart/End를 POST로 알려줌
// =====================================================
// agentManager 준비 전에 도착한 SessionStart를 임시 보관
const pendingSessionStarts = [];
// 세션별 첫 PreToolUse 여부 추적 (초기화 탐색 무시용)
const firstPreToolUseDone = new Map(); // sessionId → boolean
// PostToolUse 이후 Done 전환용 타이머 (TaskCompleted 훅이 안 오는 경우 대비)
const postToolIdleTimers = new Map(); // sessionId → timer
const POST_TOOL_IDLE_MS = 2500; // PostToolUse 후 2.5초 내 추가 훅 없으면 Done

function scheduleIdleDone(sessionId) {
  // 이미 예약된 타이머 취소
  const prev = postToolIdleTimers.get(sessionId);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(() => {
    postToolIdleTimers.delete(sessionId);
    if (!agentManager) return;
    const agent = agentManager.getAgent(sessionId);
    if (agent && agent.state === 'Working') {
      debugLog(`[Hook] Idle timeout → Done (from Working): ${sessionId.slice(0, 8)}`);
      agentManager.updateAgent({ ...agent, sessionId, state: 'Done' }, 'hook');
    }
  }, POST_TOOL_IDLE_MS);

  postToolIdleTimers.set(sessionId, timer);
}

function processHookEvent(data) {
  const event = data.hook_event_name;
  const sessionId = data.session_id || data.sessionId;
  if (!sessionId) return;

  debugLog(`[Hook] ${event} session=${sessionId.slice(0, 8)}`);

  switch (event) {
    case 'SessionStart':
      handleSessionStart(sessionId, data.cwd || '', data._pid || 0);
      break;

    case 'SessionEnd':
      handleSessionEnd(sessionId);
      break;

    case 'UserPromptSubmit':
      // 사용자가 메시지 제출 → Working (도구 없는 순수 대화도 포함)
      { const t = postToolIdleTimers.get(sessionId); if (t) clearTimeout(t); postToolIdleTimers.delete(sessionId); }
      firstPreToolUseDone.delete(sessionId);
      if (agentManager) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) {
          agentManager.updateAgent({ ...agent, sessionId, state: 'Thinking' }, 'hook');
        } else {
          // 복구에 실패했거나 30분 지나서 삭제된 경우, 다시 훅이 오면 새 세션으로 생성
          debugLog(`[Hook] auto-creating agent for existing session: ${sessionId.slice(0, 8)}`);
          handleSessionStart(sessionId, data.cwd || '');
          // 생성 직후 상태 업데이트를 위해 다시 가져옴
          setTimeout(() => {
            const newAgent = agentManager.getAgent(sessionId);
            if (newAgent) agentManager.updateAgent({ ...newAgent, state: 'Thinking' }, 'hook');
          }, 100);
        }
      }
      break;

    case 'Stop':
    case 'TaskCompleted':
      // Claude 응답 완료 → Done (타이머도 취소)
      { const t = postToolIdleTimers.get(sessionId); if (t) clearTimeout(t); postToolIdleTimers.delete(sessionId); }
      firstPreToolUseDone.delete(sessionId);
      if (agentManager) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) {
          agentManager.updateAgent({ ...agent, sessionId, state: 'Done' }, 'hook');
        } else {
          handleSessionStart(sessionId, data.cwd || '');
        }
      }
      break;

    case 'PreToolUse': {
      // idle 타이머 취소
      const prev = postToolIdleTimers.get(sessionId);
      if (prev) clearTimeout(prev);
      postToolIdleTimers.delete(sessionId);
      // 첫 PreToolUse: 세션 초기화 탐색 → 무시 (UserPromptSubmit 못 왜을 때 보험)
      if (!firstPreToolUseDone.has(sessionId)) {
        firstPreToolUseDone.set(sessionId, true);
        debugLog(`[Hook] PreToolUse ignored (first = session init)`);
      } else if (agentManager) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Working' }, 'hook');
      }
      break;
    }

    case 'PostToolUse': {
      if (agentManager && firstPreToolUseDone.has(sessionId)) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Thinking' }, 'hook');
      }
      scheduleIdleDone(sessionId);
      break;
    }

    case 'PostToolUseFailure':
    case 'Notification':
    case 'PermissionRequest':
      // 도구 실패 / 알림 / 권한 요청 → Help
      { const t = postToolIdleTimers.get(sessionId); if (t) clearTimeout(t); postToolIdleTimers.delete(sessionId); }
      if (agentManager) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Help' }, 'hook');
      }
      break;

    case 'SubagentStart': {
      const subId = data.subagent_session_id || data.agent_id;
      if (subId) handleSessionStart(subId, data.cwd || '', 0, false, true, 'Working', sessionId);
      break;
    }

    case 'SubagentStop': {
      const subId = data.subagent_session_id || data.agent_id;
      if (subId) handleSessionEnd(subId);
      break;
    }

    case 'TeammateIdle': {
      // 에이전트 팀 멤버가 작업을 멈추고 기다리는 중 -> Waiting
      if (agentManager) {
        const agent = agentManager.getAgent(sessionId);
        if (agent) agentManager.updateAgent({ ...agent, state: 'Waiting', isTeammate: true }, 'hook');
        else handleSessionStart(sessionId, data.cwd || '', 0, true); // 신규 팀원 감지 시
      }
      break;
    }

    case 'ConfigChange':
    case 'WorktreeCreate':
    case 'WorktreeRemove':
    case 'PreCompact':
      debugLog(`[Hook] Meta info: ${event} for ${sessionId.slice(0, 8)}`);
      break;

    default:
      debugLog(`[Hook] Unknown: ${event} — ${JSON.stringify(data).slice(0, 150)}`);
  }
}

function startHookServer() {
  const http = require('http');

  // P1-3: JSON Schema for hook validation
  const hookSchema = {
    type: 'object',
    required: ['hook_event_name'],
    properties: {
      hook_event_name: {
        type: 'string',
        enum: [
          'SessionStart', 'SessionEnd', 'UserPromptSubmit',
          'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
          'Stop', 'TaskCompleted', 'PermissionRequest', 'Notification',
          'SubagentStart', 'SubagentStop', 'TeammateIdle',
          'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact'
        ]
      },
      session_id: {
        type: 'string'
      },
      sessionId: {
        type: 'string'
      },
      cwd: {
        type: 'string'
      },
      state: {
        type: 'string'
      },
      tool: {
        type: 'string'
      },
      _pid: {
        type: 'number'
      },
      _timestamp: {
        type: 'number'
      }
    },
    additionalProperties: true
  };

  const ajv = new Ajv();
  const validateHook = ajv.compile(hookSchema);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404); res.end(); return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      try {
        const data = JSON.parse(body);

        // P1-3: Validate JSON schema
        const isValid = validateHook(data);
        if (!isValid) {
          errorHandler.capture(new Error('Invalid hook data'), {
            code: 'E010',
            category: 'VALIDATION',
            severity: 'WARNING',
            details: validateHook.errors
          });
          debugLog(`[Hook] Validation error: ${JSON.stringify(validateHook.errors)}`);
          return;
        }

        processHookEvent(data);
      } catch (e) {
        errorHandler.capture(e, {
          code: 'E002',
          category: 'PARSE',
          severity: 'WARNING'
        });
        debugLog(`[Hook] Parse error: ${e.message}`);
      }
    });
  });

  server.on('error', (e) => debugLog(`[Hook] Server error: ${e.message}`));
  server.listen(HOOK_SERVER_PORT, '127.0.0.1', () => {
    debugLog(`[Hook] HTTP hook server listening on port ${HOOK_SERVER_PORT}`);
  });
}
// =====================================================
// 앱 재시작 시 활성 세션 복구 및 PID 매칭 (영구 저장소 활용)
// =====================================================
function getPersistedStatePath() {
  return path.join(os.homedir(), '.pixel-agent-desk', 'state.json');
}

function savePersistedState() {
  if (!agentManager) return;
  const statePath = getPersistedStatePath();
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const agents = agentManager.getAllAgents();
  const state = {
    agents: agents,
    pids: Array.from(sessionPids.entries())
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function recoverExistingSessions() {
  if (!agentManager) return;
  const statePath = getPersistedStatePath();

  if (!fs.existsSync(statePath)) {
    debugLog('[Recover] No persisted state found.');
    return;
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    const savedAgents = state.agents || [];
    const savedPids = new Map((state.pids || []));

    let recoveredCount = 0;
    for (const agent of savedAgents) {
      const pid = savedPids.get(agent.id);

      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch (e) {
          isAlive = false;
        }
      }

      if (isAlive) {
        sessionPids.set(agent.id, pid);
        firstPreToolUseDone.set(agent.id, true);

        agentManager.updateAgent({
          sessionId: agent.id,
          projectPath: agent.projectPath,
          displayName: agent.displayName,
          state: agent.state,
          jsonlPath: agent.jsonlPath,
          isTeammate: agent.isTeammate,
          isSubagent: agent.isSubagent,
          parentId: agent.parentId
        }, 'recover');

        recoveredCount++;
        debugLog(`[Recover] Restored: ${agent.id.slice(0, 8)} (${agent.displayName}) state=${agent.state} sub=${agent.isSubagent} pid=${pid}`);
      } else {
        debugLog(`[Recover] Skipped dead agent: ${agent.id.slice(0, 8)}`);
      }
    }

    debugLog(`[Recover] Done — ${recoveredCount} session(s) restored from state.json`);
  } catch (e) {
    errorHandler.capture(e, {
      code: 'E009',
      category: 'FILE_IO',
      severity: 'WARNING'
    });
    debugLog(`[Recover] Error reading or parsing state.json: ${e.message}`);
  }

  // 2. 앱 종료 중 / 비활성화 중 기록된 훅 내역(오프라인 로그)을 순서대로 리플레이
  const hooksPath = path.join(os.homedir(), '.pixel-agent-desk', 'hooks.jsonl');
  if (fs.existsSync(hooksPath)) {
    try {
      debugLog(`[Recover] Replaying offline hooks from hooks.jsonl...`);
      const lines = fs.readFileSync(hooksPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          processHookEvent(data);
        } catch (e) { }
      }

      // 리플레이가 끝났으므로 파일 비우기
      fs.writeFileSync(hooksPath, '');
      debugLog(`[Recover] Finished replaying hooks.jsonl and cleared it.`);
    } catch (e) {
      errorHandler.capture(e, {
        code: 'E007',
        category: 'FILE_IO',
        severity: 'WARNING'
      });
      debugLog(`[Recover] Error replaying hooks.jsonl: ${e.message}`);
    }
  }
}

// =====================================================
// 생사 확인: Multi-Tier Liveness Checker with Auto-Recovery
// =====================================================
const sessionPids = new Map(); // sessionId → 실제 claude 프로세스 PID

/**
 * Tier 1: Basic process existence check using process.kill(pid, 0)
 */
async function checkLivenessTier1(agentId, pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Tier 2: Process responsiveness check via PowerShell
 */
async function checkLivenessTier2(agentId, pid) {
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
       if ($proc -and $proc.Responding) { 'true' } else { 'false' }`
    ], { encoding: 'utf8', timeout: 5000 });
    return result.stdout.trim() === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Tier 3: Session activity check via JSONL and process tree
 */
async function checkLivenessTier3(agentId, pid) {
  return await checkSessionActive(agentId, pid);
}

/**
 * Attempt to recover a ghost agent by checking if session is still active
 */
async function attemptAgentRecovery(agentId, pid) {
  try {
    debugLog(`[Live-Tier3] Attempting recovery for ${agentId.slice(0, 8)}...`);

    const isActive = await checkLivenessTier3(agentId, pid);
    if (isActive) {
      const agent = agentManager.getAgent(agentId);
      if (agent) {
        // Agent is alive but was marked as ghost - recover it
        agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live-recreate');
        debugLog(`[Live-Tier3] ✓ Recovery successful for ${agentId.slice(0, 8)}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    debugLog(`[Live-Tier3] Recovery failed for ${agentId.slice(0, 8)}: ${e.message}`);
    return false;
  }
}

function startLivenessChecker() {
  const INTERVAL = 3000;   // 3초
  const GRACE_MS = 15000;  // 등록 후 15초는 스킵 (WMI 조회 완료 전 유예)
  const MAX_MISS = 10;     // 10회 연속 실패 → DEAD (~30초로 완화)
  const missCount = new Map();
  const recoveryAttempts = new Map(); // Track recovery attempts per agent

  setInterval(async () => {
    if (!agentManager) return;
    for (const agent of agentManager.getAllAgents()) {
      // Grace 기간 내 스킵
      if (agent.firstSeen && Date.now() - agent.firstSeen < GRACE_MS) {
        missCount.delete(agent.id);
        continue;
      }

      const pid = sessionPids.get(agent.id);
      if (!pid) continue; // PID 없으면 스킵 (Grace 내에 훅으로 등록됨)

      // Tier 1: Basic process existence check
      let alive = await checkLivenessTier1(agent.id, pid);

      // Tier 2: If Tier 1 fails, check process responsiveness
      if (!alive) {
        alive = await checkLivenessTier2(agent.id, pid);
      }

      if (alive) {
        missCount.delete(agent.id);
        recoveryAttempts.delete(agent.id);
        // 만약 Offline이었다가 살아난 경우 (드문 케이스)
        if (agent.state === 'Offline') {
          agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live');
        }
      } else {
        const n = (missCount.get(agent.id) || 0) + 1;
        missCount.set(agent.id, n);

        if (n === 3) {
          // 9초 정도 안보이면 일단 Offline으로 상태 변경해서 사용자에게 알림
          if (agent.state !== 'Offline') {
            debugLog(`[Live-Tier1] ${agent.id.slice(0, 8)} pid=${pid} suspicious → Offline`);
            agentManager.updateAgent({ ...agent, state: 'Offline' }, 'live');
          }
        }

        if (n >= MAX_MISS) {
          // DEAD 판정: 서브에이전트가 있는지 확인
          const children = agentManager.getAllAgents().filter(a => a.parentId === agent.id);
          const hasActiveChildren = children.length > 0;

          if (hasActiveChildren) {
            // 자식이 있으면 보이지 않아도 아바타는 유지 (상태만 Offline/Done으로)
            if (agent.state !== 'Offline') {
              agentManager.updateAgent({ ...agent, state: 'Offline' }, 'live');
            }
            debugLog(`[Live-Tier1] ${agent.id.slice(0, 8)} pid=${pid} DEAD but keeps for active sub-agents`);
          } else {
            // Tier 3: 마지막으로 세션 활성 상태 확인 후 자동 복구 시도
            const attempts = recoveryAttempts.get(agent.id) || 0;

            if (attempts < 2) {
              // 최대 2번 복구 시도
              recoveryAttempts.set(agent.id, attempts + 1);
              debugLog(`[Live-Tier3] ${agent.id.slice(0, 8)} pid=${pid} DEAD → attempting recovery (${attempts + 1}/2)`);

              const recovered = await attemptAgentRecovery(agent.id, pid);
              if (recovered) {
                // 복구 성공: missCount 리셋
                missCount.delete(agent.id);
                continue;
              }
            }

            // 복구 실패 또는 복구 시도 초과: 제거
            debugLog(`[Live-Tier3] ${agent.id.slice(0, 8)} pid=${pid} recovery failed → removing agent`);
            missCount.delete(agent.id);
            sessionPids.delete(agent.id);
            agentManager.removeAgent(agent.id);
          }
        } else if (n > 1) {
          debugLog(`[Live-Tier1] ${agent.id.slice(0, 8)} pid=${pid} miss ${n}/${MAX_MISS}`);
        }
      }
    }
  }, INTERVAL);
}


function handleSessionStart(sessionId, cwd, pid = 0, isTeammate = false, isSubagent = false, initialState = 'Waiting', parentId = null) {
  if (!agentManager) {
    pendingSessionStarts.push({ sessionId, cwd, ts: Date.now(), isTeammate, isSubagent, initialState, parentId });
    debugLog(`[Hook] SessionStart queued: ${sessionId.slice(0, 8)}`);
    return;
  }
  const displayName = cwd ? path.basename(cwd) : 'Agent';
  agentManager.updateAgent({ sessionId, projectPath: cwd, displayName, state: initialState, jsonlPath: null, isTeammate, isSubagent, parentId }, 'http');
  debugLog(`[Hook] SessionStart → agent: ${sessionId.slice(0, 8)} (${displayName}) ${isTeammate ? '[Team]' : ''} ${isSubagent ? '[Sub]' : ''} (Parent: ${parentId ? parentId.slice(0, 8) : 'none'})`);

  if (pid > 0) {
    sessionPids.set(sessionId, pid);
    return;
  }
  const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude*cli.js*' } | Select-Object -ExpandProperty ProcessId`;
  const { execFile } = require('child_process');
  execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 6000 }, (err, stdout) => {
    if (err || !stdout) return;
    const allPids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
    const registeredPids = new Set(sessionPids.values());
    const newPid = allPids.find(p => !registeredPids.has(p));
    if (newPid) {
      sessionPids.set(sessionId, newPid);
      debugLog(`[Hook] SessionStart PID assigned: ${sessionId.slice(0, 8)} → pid=${newPid}`);
    }
  });
}

function cleanupAgentResources(sessionId) {
  // 1. 플래그 정리
  firstPreToolUseDone.delete(sessionId);

  // 2. 타이머 정리
  const timer = postToolIdleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    postToolIdleTimers.delete(sessionId);
  }

  // 3. PID 정리
  sessionPids.delete(sessionId);

  // 4. 생존 확인 카운터 정리 (startLivenessChecker의 missCount Map 접근을 위해 전역에서 삭제)
  // Note: missCount는 startLivenessChecker 함수 내부 스코프에 있으므로,
  //       생존 확인 checker에서 자연스럽게 정리됩니다.

  debugLog(`[Cleanup] Resources cleared for ${sessionId.slice(0, 8)}`);
}

function handleSessionEnd(sessionId) {
  cleanupAgentResources(sessionId);  // 통합 리소스 정리

  if (!agentManager) return;
  const agent = agentManager.getAgent(sessionId);
  if (agent) {
    debugLog(`[Hook] SessionEnd → removing agent ${sessionId.slice(0, 8)}`);
    // JSONL에 SessionEnd 기록 (LogMonitor 좀비 방지)
    if (agent.jsonlPath && fs.existsSync(agent.jsonlPath)) {
      try {
        fs.appendFileSync(agent.jsonlPath, JSON.stringify({
          type: 'system', subtype: 'SessionEnd',
          sessionId: agent.id, timestamp: new Date().toISOString()
        }) + '\n');
      } catch (e) { }
    }
    agentManager.removeAgent(sessionId);
  } else {
    debugLog(`[Hook] SessionEnd for unknown agent ${sessionId.slice(0, 8)}`);
  }
}



app.whenReady().then(() => {
  debugLog('Pixel Agent Desk started');

  // 1. 에이전트 매니저 즉시 시작 (UI 뜨기 전부터 데이터 수집)
  agentManager = new AgentManager();
  agentManager.start();

  // 2. 백그라운드 서비스 시작
  startHookServer();       // HTTP 훅 서버 (47821 포트)
  // setupClaudeHooks();   // settings.json 훅 자동 등록 (사용 안 함)
  startLivenessChecker();  // 프로세스 생사 확인

  // 3. 앱 재시작 시 기존 활성 세션 복구 시작
  recoverExistingSessions();

  // 4. 테스트용 에이전트 (Main, Sub, Team 골고루)
  const ENABLE_TEST_AGENTS = false; // 테스트 에이전트 온/오프 체크 옵션
  if (ENABLE_TEST_AGENTS) {
    const testSubagents = [
      { sessionId: 'test-main-1', projectPath: 'E:/projects/core-engine', displayName: 'Main Service', state: 'Working', isSubagent: false, isTeammate: false },
      { sessionId: 'test-sub-1', projectPath: 'E:/projects/core-engine', displayName: 'Refactor Helper', state: 'Working', isSubagent: true, isTeammate: false },
      { sessionId: 'test-team-1', projectPath: 'E:/projects/web-ui', displayName: 'UI Architect', state: 'Waiting', isSubagent: false, isTeammate: true },
      { sessionId: 'test-team-2', projectPath: 'E:/projects/web-ui', displayName: 'CSS Specialist', state: 'Working', isSubagent: false, isTeammate: true }
    ];
    testSubagents.forEach(agent => agentManager.updateAgent(agent, 'test'));
  }

  // 5. UI 생성
  createWindow();

  // Renderer가 준비되면 현재 상태 전송
  ipcMain.once('renderer-ready', () => {
    debugLog('[Main] renderer-ready event received!');

    // 에이전트 매니저 이벤트 연결 (이미 생성된 상태이므로 여기서 연결)
    agentManager.on('agent-added', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-added', agent);
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Dashboard window
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        const adaptedAgent = adaptAgentToMissionControl(agent);
        dashboardWindow.webContents.send('dashboard-agent-added', adaptedAgent);
      }
      savePersistedState();
    });

    agentManager.on('agent-updated', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-updated', agent);
        // 상태 변화로 Sub/Team이 생기면 창 크기가 달라질 수 있으므로 업데이트
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Dashboard window
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        const adaptedAgent = adaptAgentForMissionControl(agent);
        dashboardWindow.webContents.send('dashboard-agent-updated', adaptedAgent);
      }
      savePersistedState();
    });

    agentManager.on('agent-removed', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-removed', data);
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Dashboard window
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('dashboard-agent-removed', data);
      }
      savePersistedState();
    });

    agentManager.on('agents-cleaned', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agents-cleaned', data);
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Dashboard window
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('dashboard-agent-removed', { type: 'batch', ...data });
      }
      savePersistedState();
    });

    // 준비 전에 도착했던 세션 및 복구된 데이터 전송
    const allAgents = agentManager.getAllAgents();
    if (allAgents.length > 0) {
      debugLog(`[Main] Sending ${allAgents.length} agents to newly ready renderer`);
      allAgents.forEach(agent => {
        mainWindow.webContents.send('agent-added', agent);
      });
      resizeWindowForAgents(allAgents);
    }

    while (pendingSessionStarts.length > 0) {
      const { sessionId, cwd, isTeammate, isSubagent, initialState, parentId } = pendingSessionStarts.shift();
      handleSessionStart(sessionId, cwd, 0, isTeammate, isSubagent, initialState || 'Waiting', parentId);
    }
  });

  // 좌비 에이전트 방지 (30분 미활성)
  const INACTIVE_MS = 30 * 60 * 1000;
  setInterval(() => {
    if (!agentManager) return;
    const now = Date.now();
    for (const agent of agentManager.getAllAgents()) {
      const age = now - (agent.lastActivity || agent.firstSeen || 0);
      if (age > INACTIVE_MS) {
        debugLog(`[Main] Inactive removal: ${agent.displayName}`);
        agentManager.removeAgent(agent.id);
      }
    }
  }, 5 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (agentManager) agentManager.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentManager) agentManager.stop();
  stopKeepAlive(); // 앱 종료 시 interval 정리

  // 모든 Map 리소스 정리
  firstPreToolUseDone.clear();
  postToolIdleTimers.forEach(timer => clearTimeout(timer));
  postToolIdleTimers.clear();
  sessionPids.clear();
  pendingSessionStarts.length = 0;

  debugLog('[Main] All Map resources cleaned up');
});

// =====================================================
// IPC 핸들러
// =====================================================

ipcMain.on('get-work-area', (event) => {
  event.reply('work-area-response', screen.getPrimaryDisplay().workArea);
});

ipcMain.on('get-avatars', (event) => {
  try {
    const charsDir = path.join(__dirname, 'public', 'characters');
    if (fs.existsSync(charsDir)) {
      const files = fs.readdirSync(charsDir);
      event.reply('avatars-response', files);
    } else {
      event.reply('avatars-response', []);
    }
  } catch (e) {
    errorHandler.capture(e, {
      code: 'E003',
      category: 'FILE_IO',
      severity: 'WARNING'
    });
    debugLog(`[Main] get-avatars error: ${e.message}`);
    event.reply('avatars-response', []);
  }
});

ipcMain.on('constrain-window', (event, bounds) => {
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = mainWindow.getBounds();
  mainWindow.setPosition(
    Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width)),
    Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height))
  );
});

ipcMain.on('get-all-agents', (event) => event.reply('all-agents-response', agentManager?.getAllAgents() ?? []));
ipcMain.on('get-agent-stats', (event) => event.reply('agent-stats-response', agentManager?.getStats() ?? {}));

// 에이전트 수동 퇴근 IPC 핸들러
ipcMain.on('dismiss-agent', (event, agentId) => {
  if (agentManager) agentManager.dismissAgent(agentId);
});

// 터미널 포커스 IPC 핸들러 (실제 PID 활용)
ipcMain.on('focus-terminal', (event, agentId) => {
  const pid = sessionPids.get(agentId);
  if (!pid) return;

  debugLog(`[Main] Focus requested for agent=${agentId.slice(0, 8)} pid=${pid}`);

  // PowerShell을 사용하여 해당 PID를 소유한 창을 최상단으로 올림
  const { exec } = require('child_process');
  const psCmd = `
    $targetPid = ${pid};
    $wshell = New-Object -ComObject WScript.Shell;
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue;
    if ($proc) {
      $hwnd = $proc.MainWindowHandle;
      if ($hwnd -eq 0) {
        # MainWindowHandle이 없는 경우 부모/자식 관계 탐색 (터미널 쉘 특성)
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" | Select-Object -ExpandProperty ParentProcessId;
        $proc = Get-Process -Id $parent -ErrorAction SilentlyContinue;
        $hwnd = $proc.MainWindowHandle;
      }
      if ($hwnd -ne 0) {
        $type = "[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);";
        Add-Type -MemberDefinition $type -Name "Win32Utils" -Namespace "Win32";
        [Win32.Win32Utils]::SetForegroundWindow($hwnd);
      }
    }
  `.replace(/\n/g, ' ');

  exec(`powershell.exe -NoProfile -Command "${psCmd}"`, (err) => {
    if (err) debugLog(`[Main] Focus error: ${err.message}`);
  });
});

// =====================================================
// Dashboard IPC Handlers
// =====================================================

// Open Dashboard dashboard
ipcMain.handle('open-web-dashboard', async (event) => {
  try {
    const result = createDashboardWindow();
    return result;
  } catch (error) {
    debugLog(`[MissionControl] Error opening dashboard: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Close Dashboard dashboard
ipcMain.handle('close-web-dashboard', async (event) => {
  try {
    closeMissionControlWindow();
    return { success: true };
  } catch (error) {
    debugLog(`[MissionControl] Error closing dashboard: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Check if Dashboard dashboard is open
ipcMain.handle('is-web-dashboard-open', async (event) => {
  return {
    isOpen: dashboardWindow !== null && !dashboardWindow.isDestroyed()
  };
});

// Get error logs (P0-3: Error Recovery)
ipcMain.handle('get-error-logs', async () => {
  try {
    const logs = errorHandler.readRecentLogs(100);
    return { success: true, logs };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Execute recovery action (P0-3: Error Recovery)
ipcMain.handle('execute-recovery-action', async (event, errorId, action) => {
  try {
    debugLog(`[ErrorRecovery] Executing action: ${action} for error: ${errorId}`);

    // TODO: 각 액션별 구현 필요
    switch (action) {
      case 'retry':
        // 재시도 로직
        break;
      case 'reset':
        // 초기화 로직
        break;
      case 'view_logs':
        // 로그 뷰어 열기
        break;
      default:
        break;
    }

    return { success: true };
  } catch (error) {
    errorHandler.capture(error, {
      code: 'E000',
      category: 'UNKNOWN',
      severity: 'ERROR'
    });
    return { success: false, error: error.message };
  }
});

// Handle focus-agent command from Dashboard
ipcMain.on('dashboard-focus-agent', (event, agentId) => {
  debugLog(`[MissionControl] Focus requested for agent: ${agentId.slice(0, 8)}`);
  // Forward to the existing focus-terminal handler
  const pid = sessionPids.get(agentId);
  if (!pid) {
    debugLog(`[MissionControl] No PID found for agent: ${agentId.slice(0, 8)}`);
    return;
  }

  const { exec } = require('child_process');
  const psCmd = `
    $targetPid = ${pid};
    $wshell = New-Object -ComObject WScript.Shell;
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue;
    if ($proc) {
      $hwnd = $proc.MainWindowHandle;
      if ($hwnd -eq 0) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" | Select-Object -ExpandProperty ParentProcessId;
        $proc = Get-Process -Id $parent -ErrorAction SilentlyContinue;
        $hwnd = $proc.MainWindowHandle;
      }
      if ($hwnd -ne 0) {
        $type = "[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);";
        Add-Type -MemberDefinition $type -Name "Win32Utils" -Namespace "Win32";
        [Win32.Win32Utils]::SetForegroundWindow($hwnd);
      }
    }
  `.replace(/\n/g, ' ');

  exec(`powershell.exe -NoProfile -Command "${psCmd}"`, (err) => {
    if (err) debugLog(`[MissionControl] Focus error: ${err.message}`);
  });
});

// Handle dismiss-agent command from Dashboard
ipcMain.on('dashboard-dismiss-agent', (event, agentId) => {
  debugLog(`[MissionControl] Dismiss requested for agent: ${agentId.slice(0, 8)}`);
  if (agentManager) {
    agentManager.dismissAgent(agentId);
  }
});

// Get current agents for Dashboard
ipcMain.on('get-dashboard-agents', (event) => {
  if (agentManager) {
    const agents = agentManager.getAllAgents();
    const adaptedAgents = agents.map(agent => adaptAgentToMissionControl(agent));
    event.reply('dashboard-agents-response', adaptedAgents);
  } else {
    event.reply('dashboard-agents-response', []);
  }
});

