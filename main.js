const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const AgentManager = require('./agentManager');

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
function getWindowSizeForAgents(count) {
  if (count <= 1) return { width: 220, height: 200 };

  // 멀티 에이전트: 카드 90px × N + 갭 + 외부 패딩
  const CARD_W = 90;
  const GAP = 10;
  const OUTER = 20;
  const HEIGHT = 195;

  const width = Math.max(220, count * CARD_W + (count - 1) * GAP + OUTER);
  return { width, height: HEIGHT };
}

function resizeWindowForAgents(count) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = getWindowSizeForAgents(count);
  mainWindow.setSize(width, height);
  console.log(`[Main] Window → ${width}×${height} (${count} agents)`);
}

// =====================================================
// 윈도우 생성
// =====================================================
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

    // command 훅으로 모든 이벤트를 hook.js로 전달
    const HOOK_EVENTS = [
      'SessionStart', 'SessionEnd',
      'UserPromptSubmit',           // 사용자 메시지 제출 → Working
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'Stop',                       // Claude 응답 완료 → Done
      'TaskCompleted',
      'PermissionRequest', 'Notification',
      'SubagentStart', 'SubagentStop',
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
              if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Working' }, 'hook');
            }
            break;

          case 'Stop':
          case 'TaskCompleted':
            // Claude 응답 완료 → Done (타이머도 취소)
            { const t = postToolIdleTimers.get(sessionId); if (t) clearTimeout(t); postToolIdleTimers.delete(sessionId); }
            firstPreToolUseDone.delete(sessionId);
            if (agentManager) {
              const agent = agentManager.getAgent(sessionId);
              if (agent) agentManager.updateAgent({ ...agent, sessionId, state: 'Done' }, 'hook');
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
            if (subId) handleSessionStart(subId, data.cwd || '');
            break;
          }

          case 'SubagentStop': {
            const subId = data.subagent_session_id || data.agent_id;
            if (subId) handleSessionEnd(subId);
            break;
          }

          default:
            debugLog(`[Hook] Unknown: ${event} — ${JSON.stringify(data).slice(0, 150)}`);
        }
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
// 앱 재시작 시 기존 활성 세션 복구 및 PID 매칭 (1회 실행)
// =====================================================
function recoverExistingSessions() {
  if (!agentManager) return;
  const { execFile } = require('child_process');

  // 1. 현재 살아있는 claude 프로세스 PID 목록 조회
  const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude*cli.js*' } | Select-Object -ExpandProperty ProcessId`;

  execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 8000 }, (err, stdout) => {
    const livePids = [];
    if (!err && stdout) {
      livePids.push(...stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0));
    }

    if (livePids.length === 0) {
      debugLog('[Recover] No running Claude processes found.');
      return;
    }

    debugLog(`[Recover] Found ${livePids.length} Claude process(es). Scanning JSONL for matching sessions...`);

    // 2. ~/.claude/projects/ 스캔 (30분 조건 제외, 최신 파일부터 위에서 컷)
    const projectsDir = require('path').join(require('os').homedir(), '.claude', 'projects');
    if (!require('fs').existsSync(projectsDir)) return;

    const candidates = [];
    try {
      for (const projectEntry of require('fs').readdirSync(projectsDir, { withFileTypes: true })) {
        if (!projectEntry.isDirectory()) continue;
        const projectPath = require('path').join(projectsDir, projectEntry.name);

        for (const file of require('fs').readdirSync(projectPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = require('path').join(projectPath, file);
          try {
            const stat = require('fs').statSync(filePath);
            candidates.push({ filePath, mtime: stat.mtimeMs, size: stat.size, projectPath });
          } catch (e) { }
        }
      }

      // 최신 수정 시간(mtime) 순으로 정렬
      candidates.sort((a, b) => b.mtime - a.mtime);

      const recoveredSessions = [];
      for (const candidate of candidates) {
        if (recoveredSessions.length >= livePids.length) break; // 살아있는 프로세스 수만큼만 복구

        try {
          const readSize = Math.min(candidate.size, 8192); // 파일 끝 8KB
          const buf = Buffer.alloc(readSize);
          const fd = require('fs').openSync(candidate.filePath, 'r');
          require('fs').readSync(fd, buf, 0, readSize, candidate.size - readSize);
          require('fs').closeSync(fd);

          const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
          let sessionId = null, cwd = candidate.projectPath, hasSessionEnd = false;

          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.sessionId) sessionId = obj.sessionId;
              if (obj.cwd) cwd = obj.cwd;
              if (obj.subtype === 'SessionEnd') hasSessionEnd = true;
            } catch (e) { }
          }

          if (sessionId && !hasSessionEnd && !agentManager.getAgent(sessionId)) {
            recoveredSessions.push({ sessionId, cwd, filePath: candidate.filePath });
          }
        } catch (e) { }
      }

      // 3. 복구된 세션 등록
      for (let i = 0; i < recoveredSessions.length; i++) {
        const { sessionId, cwd, filePath } = recoveredSessions[i];

        const displayName = cwd ? require('path').basename(cwd) : 'Agent';

        // 중요: 기존 세션은 초기화가 끝났으므로 UserPromptSubmit 전 1회 무시 로직을 우회하도록 설정
        firstPreToolUseDone.set(sessionId, true);

        // recovered된 에이전트는 firstSeen을 의도적으로 과거로 밀어 Liveness Checker 유예기간을 없앰
        const recoveredAgent = agentManager.updateAgent({ sessionId, projectPath: cwd, displayName, state: 'Waiting', jsonlPath: filePath }, 'recover');
        if (recoveredAgent) recoveredAgent.firstSeen = Date.now() - 30000;

        debugLog(`[Recover] Restored: ${sessionId.slice(0, 8)} (${displayName})`);
      }
      debugLog(`[Recover] Done — ${recoveredSessions.length} session(s) recovered based on live processes`);

    } catch (e) {
      debugLog(`[Recover] Error: ${e.message}`);
    }
  });
}

// =====================================================
// 생사 확인: claude 프로세스 개수 === 에이전트 개수 비교
// =====================================================
function startLivenessChecker() {
  const { execFile } = require('child_process');
  const INTERVAL = 3000;   // 3초마다 확인
  const GRACE_MS = 10000;  // 등록 직후 10초는 스킵
  const MAX_MISS = 2;      // 2회 연속 초과 시 DEAD
  const missCount = new Map();

  const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude*cli.js*' } | Measure-Object | Select-Object -ExpandProperty Count`;

  setInterval(() => {
    if (!agentManager) return;
    const agents = agentManager.getAllAgents();
    if (agents.length === 0) { missCount.clear(); return; }

    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 8000 }, (err, stdout) => {
      if (err) return;
      const liveCount = parseInt(stdout.trim(), 10) || 0;

      const checkable = agents.filter(a => !a.firstSeen || Date.now() - a.firstSeen >= GRACE_MS);
      if (checkable.length === 0) return;

      if (liveCount >= checkable.length) {
        for (const a of checkable) missCount.delete(a.id);
        return;
      }

      const excess = checkable.length - liveCount;
      const sorted = [...checkable].sort((a, b) => (a.lastActivity || 0) - (b.lastActivity || 0));

      for (const a of sorted.slice(excess)) missCount.delete(a.id);
      for (const a of sorted.slice(0, excess)) {
        const n = (missCount.get(a.id) || 0) + 1;
        missCount.set(a.id, n);
        if (n < MAX_MISS) {
          debugLog(`[Live] ${a.id.slice(0, 8)} suspect ${n}/${MAX_MISS}`);
        } else {
          debugLog(`[Live] ${a.id.slice(0, 8)} DEAD → removing`);
          missCount.delete(a.id);
          agentManager.removeAgent(a.id);
        }
      }
    });
  }, INTERVAL);
}


function handleSessionStart(sessionId, cwd) {
  if (!agentManager) {
    pendingSessionStarts.push({ sessionId, cwd, ts: Date.now() });
    debugLog(`[Hook] SessionStart queued: ${sessionId.slice(0, 8)}`);
    return;
  }
  const displayName = cwd ? require('path').basename(cwd) : 'Agent';
  agentManager.updateAgent({
    sessionId,
    projectPath: cwd,
    displayName,
    state: 'Waiting',
    jsonlPath: null
  }, 'http');
  debugLog(`[Hook] SessionStart → agent: ${sessionId.slice(0, 8)} pid=${pid} (${displayName})`);
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
  startHookServer();       // HTTP 훅 서버
  setupClaudeHooks();      // settings.json 훅 자동 등록
  startLivenessChecker();  // 죽기적 생사 확인 (15초)
  createWindow();


  ipcMain.once('renderer-ready', () => {
    debugLog('[Main] renderer-ready event received!');

    agentManager = new AgentManager();
    agentManager.start();
    debugLog('[Main] AgentManager started');

    // agentManager 준비 전에 도착한 SessionStart 처리
    while (pendingSessionStarts.length > 0) {
      const { sessionId, cwd } = pendingSessionStarts.shift();
      handleSessionStart(sessionId, cwd);
    }

    // 에이전트 이벤트 → renderer IPC 전달 + 동적 리사이징
    agentManager.on('agent-added', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-added', agent);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    agentManager.on('agent-updated', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-updated', agent);
      }
    });

    agentManager.on('agent-removed', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-removed', data);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    agentManager.on('agents-cleaned', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agents-cleaned', data);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    logMonitor = null; // 레거시 (no-op)

    // 앱 재시작 시 기존 활성 세션 복구 (1회)
    recoverExistingSessions();

    // 좌비 에이전트 방지: lastActivity 기준 30분 미활성 시 제거
    const INACTIVE_MS = 30 * 60 * 1000;
    function checkInactiveAgents() {
      if (!agentManager) return;
      const now = Date.now();
      for (const agent of agentManager.getAllAgents()) {
        const age = now - (agent.lastActivity || agent.firstSeen || 0);
        if (age > INACTIVE_MS) {
          debugLog(`[Main] Agent '${agent.displayName}' inactive ${Math.round(age / 60000)}min → removing`);
          agentManager.removeAgent(agent.id);
        }
      }
    }
    setInterval(() => checkInactiveAgents(), 5 * 60 * 1000);
  });

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
