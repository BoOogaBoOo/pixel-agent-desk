const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const AgentManager = require('./agentManager');
const { adaptAgentToMissionControl } = require('./missionControlAdapter');

// Debug logging to file
const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(path.join(__dirname, 'debug.log'), logMsg);
  console.log(msg);
};

let mainWindow;
let agentManager = null;

// =====================================================
// 에이전트 수에 따른 동적 윈도우 크기 (P1-6)
// =====================================================
function getWindowSizeForAgents(agentsOrCount) {
  let count = 0;
  let agents = [];
  if (Array.isArray(agentsOrCount)) {
    agents = agentsOrCount;
    count = agents.length;
  } else {
    count = agentsOrCount || 0;
  }

  if (count <= 1) return { width: 220, height: 260 };

  const CARD_W = 90;
  const GAP = 10;
  const OUTER = 120 + 20; // 팀 디자인 여백 감안
  const ROW_H = 200;
  const BASE_H = 260;
  const maxCols = 10;

  if (agents.length > 0) {
    const groups = {};
    agents.forEach(a => {
      const p = a.projectPath || 'default';
      if (!groups[p]) groups[p] = [];
      groups[p].push(a);
    });

    let teamRows = 0;
    let soloCount = 0;
    let maxColsInRow = 0;

    for (const group of Object.values(groups)) {
      const isTeam = group.some(a => a.isSubagent || a.isTeammate);
      if (isTeam) {
        teamRows += Math.ceil(group.length / maxCols);
        maxColsInRow = Math.max(maxColsInRow, Math.min(group.length, maxCols));
      } else {
        soloCount += group.length;
      }
    }

    const soloRows = Math.ceil(soloCount / maxCols);
    if (soloCount > 0) {
      maxColsInRow = Math.max(maxColsInRow, Math.min(soloCount, maxCols));
    }

    const totalRows = teamRows + soloRows;
    const width = Math.max(220, maxColsInRow * CARD_W + (maxColsInRow - 1) * GAP + OUTER);
    const height = BASE_H + Math.max(0, totalRows - 1) * ROW_H + (teamRows * 30); // 팀 그룹 여백(padding) 감안

    return { width, height };
  }

  // Fallback (agents 배열이 없는 경우 단순 count로 계산)
  const cols = Math.min(count, maxCols);
  const rows = Math.ceil(count / maxCols);

  const width = Math.max(220, cols * CARD_W + (cols - 1) * GAP + OUTER);
  const height = BASE_H + (rows - 1) * ROW_H;

  return { width, height };
}

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
    const { width, height } = mainWindow.getBounds();
    const newWidth = Math.max(220, size.width || width);
    const newHeight = Math.max(260, (size.height || height) + 40); // 40px padding bottom

    // Bottom-anchor logic: calculate Y position change
    // If window becomes taller, y should move up by the difference
    const diffHeight = newHeight - height;
    const { y } = mainWindow.getBounds();
    const newY = Math.max(0, y - diffHeight);

    mainWindow.setBounds({ width: newWidth, height: newHeight, y: newY });
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
    resizable: false,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  // 작업표시줄 복구 폴링 (250ms)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 250);
}

// =====================================================
// Mission Control Dashboard Window Management
// =====================================================
let missionControlWindow = null;
let missionControlAuthToken = null;

function generateAuthToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function createMissionControlWindow() {
  if (missionControlWindow && !missionControlWindow.isDestroyed()) {
    debugLog('[MissionControl] Window already open, focusing existing window');
    missionControlWindow.focus();
    return { success: true, alreadyOpen: true };
  }

  try {
    // Generate auth token for this session
    missionControlAuthToken = generateAuthToken();
    debugLog(`[MissionControl] Generated auth token: ${missionControlAuthToken.slice(0, 8)}...`);

    // Get current agents and adapt them for Mission Control
    const agents = agentManager ? agentManager.getAllAgents() : [];
    const adaptedAgents = agents.map(agent => adaptAgentToMissionControl(agent));
    const agentDataParam = encodeURIComponent(JSON.stringify(adaptedAgents));

    // Construct URL with auth and data
    // Mission Control should be running on localhost:3000
    const url = `http://localhost:3000?token=${missionControlAuthToken}&agents=${agentDataParam}&source=pixel-agent-desk`;

    // Get display dimensions for positioning
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    // Create window with secure settings
    missionControlWindow = new BrowserWindow({
      width: Math.floor(width * 0.8),
      height: Math.floor(height * 0.8),
      x: Math.floor(width * 0.1),
      y: Math.floor(height * 0.1),
      title: 'Mission Control Dashboard',
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'missionControlPreload.js')
      }
    });

    // Log when window is ready
    missionControlWindow.webContents.on('did-finish-load', () => {
      debugLog('[MissionControl] Window loaded successfully');
    });

    // Handle navigation errors
    missionControlWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      debugLog(`[MissionControl] Failed to load: ${errorCode} - ${errorDescription}`);
      missionControlWindow.destroy();
      missionControlWindow = null;
      missionControlAuthToken = null;
    });

    // Clean up when window is closed
    missionControlWindow.on('closed', () => {
      debugLog('[MissionControl] Window closed');
      missionControlWindow = null;
      missionControlAuthToken = null;
    });

    missionControlWindow.loadURL(url);
    debugLog('[MissionControl] Window created and loading URL');

    return { success: true };

  } catch (error) {
    debugLog(`[MissionControl] Failed to create window: ${error.message}`);
    missionControlWindow = null;
    missionControlAuthToken = null;
    return { success: false, error: error.message };
  }
}

function closeMissionControlWindow() {
  if (missionControlWindow && !missionControlWindow.isDestroyed()) {
    missionControlWindow.close();
    debugLog('[MissionControl] Window closed by request');
  }
  missionControlWindow = null;
  missionControlAuthToken = null;
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
        try { fs.copyFileSync(settingsPath, settingsPath + '.corrupt_backup'); } catch (e) { }
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
    if (agent && (agent.state === 'Working' || agent.state === 'Thinking')) {
      debugLog(`[Hook] Idle timeout → Done: ${sessionId.slice(0, 8)}`);
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
          agentManager.updateAgent({ ...agent, sessionId, state: 'Working' }, 'hook');
        } else {
          // 복구에 실패했거나 30분 지나서 삭제된 경우, 다시 훅이 오면 새 세션으로 생성
          debugLog(`[Hook] auto-creating agent for existing session: ${sessionId.slice(0, 8)}`);
          handleSessionStart(sessionId, data.cwd || '');
          // 생성 직후 상태 업데이트를 위해 다시 가져옴
          setTimeout(() => {
            const newAgent = agentManager.getAgent(sessionId);
            if (newAgent) agentManager.updateAgent({ ...newAgent, state: 'Working' }, 'hook');
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
        if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Working' }, 'hook');
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
        processHookEvent(data);
      } catch (e) {
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
      debugLog(`[Recover] Error replaying hooks.jsonl: ${e.message}`);
    }
  }
}

// =====================================================
// 생사 확인: sessionPids의 실제 PID로 process.kill(pid,0) 직접 체크
// PID 없는 경우(새 세션 등)는 Grace 기간 내 훅이 오면 자동 등록됨
// =====================================================
const sessionPids = new Map(); // sessionId → 실제 claude 프로세스 PID

function startLivenessChecker() {
  const INTERVAL = 3000;   // 3초
  const GRACE_MS = 15000;  // 등록 후 15초는 스킵 (WMI 조회 완료 전 유예)
  const MAX_MISS = 2;      // 2회 연속 실패 → DEAD (~6초)
  const missCount = new Map();

  setInterval(() => {
    if (!agentManager) return;
    for (const agent of agentManager.getAllAgents()) {
      // Grace 기간 내 스킵
      if (agent.firstSeen && Date.now() - agent.firstSeen < GRACE_MS) {
        missCount.delete(agent.id);
        continue;
      }

      const pid = sessionPids.get(agent.id);
      if (!pid) continue; // PID 없으면 스킵 (Grace 내에 훅으로 등록됨)

      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { }

      if (alive) {
        missCount.delete(agent.id);
      } else {
        const n = (missCount.get(agent.id) || 0) + 1;
        missCount.set(agent.id, n);
        if (n < MAX_MISS) {
          debugLog(`[Live] ${agent.id.slice(0, 8)} pid=${pid} miss ${n}/${MAX_MISS}`);
        } else {
          debugLog(`[Live] ${agent.id.slice(0, 8)} pid=${pid} DEAD → removing`);
          missCount.delete(agent.id);
          sessionPids.delete(agent.id);
          agentManager.removeAgent(agent.id);
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

function handleSessionEnd(sessionId) {
  firstPreToolUseDone.delete(sessionId);   // 플래그 정리
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
  startHookServer();       // HTTP 훅 서버
  setupClaudeHooks();      // settings.json 훅 자동 등록
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
      // Forward to Mission Control
      if (missionControlWindow && !missionControlWindow.isDestroyed()) {
        const adaptedAgent = adaptAgentForMissionControl(agent);
        missionControlWindow.webContents.send('mission-agent-added', adaptedAgent);
      }
      savePersistedState();
    });

    agentManager.on('agent-updated', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-updated', agent);
        // 상태 변화로 Sub/Team이 생기면 창 크기가 달라질 수 있으므로 업데이트
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Mission Control
      if (missionControlWindow && !missionControlWindow.isDestroyed()) {
        const adaptedAgent = adaptAgentForMissionControl(agent);
        missionControlWindow.webContents.send('mission-agent-updated', adaptedAgent);
      }
      savePersistedState();
    });

    agentManager.on('agent-removed', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-removed', data);
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Mission Control
      if (missionControlWindow && !missionControlWindow.isDestroyed()) {
        missionControlWindow.webContents.send('mission-agent-removed', data);
      }
      savePersistedState();
    });

    agentManager.on('agents-cleaned', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agents-cleaned', data);
        resizeWindowForAgents(agentManager.getAllAgents());
      }
      // Forward to Mission Control
      if (missionControlWindow && !missionControlWindow.isDestroyed()) {
        missionControlWindow.webContents.send('mission-agent-removed', { type: 'batch', ...data });
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
// Mission Control IPC Handlers
// =====================================================

// Open Mission Control dashboard
ipcMain.handle('open-web-dashboard', async (event) => {
  try {
    const result = createMissionControlWindow();
    return result;
  } catch (error) {
    debugLog(`[MissionControl] Error opening dashboard: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Close Mission Control dashboard
ipcMain.handle('close-web-dashboard', async (event) => {
  try {
    closeMissionControlWindow();
    return { success: true };
  } catch (error) {
    debugLog(`[MissionControl] Error closing dashboard: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Check if Mission Control dashboard is open
ipcMain.handle('is-web-dashboard-open', async (event) => {
  return {
    isOpen: missionControlWindow !== null && !missionControlWindow.isDestroyed()
  };
});

// Handle focus-agent command from Mission Control
ipcMain.on('mission-focus-agent', (event, agentId) => {
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

// Handle dismiss-agent command from Mission Control
ipcMain.on('mission-dismiss-agent', (event, agentId) => {
  debugLog(`[MissionControl] Dismiss requested for agent: ${agentId.slice(0, 8)}`);
  if (agentManager) {
    agentManager.dismissAgent(agentId);
  }
});
