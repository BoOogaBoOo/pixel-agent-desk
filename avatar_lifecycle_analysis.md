# 에이전트 아바타 생명주기 분석 보고서

## 개요
본 문서는 Pixel Agent Desk에서 에이전트 아바타가 생성되어 소멸되기까지의 전체 생명주기를 분석하고, 현재 구현의 문제점과 개선안을 제시합니다.

---

## 1. 에이전트 생성 (Agent Creation)

### 1.1 생성 시점

#### SessionStart 훅 처리
- **위치**: `E:\projects\pixel-agent-desk-master\main.js:846-872`
- **트리거**: Claude CLI의 `SessionStart` 훅 이벤트 수신
- **처리 흐름**:
  1. 훅 서버(포트 47821)가 JSON 데이터 수신
  2. `processHookEvent()` 함수에서 `SessionStart` 이벤트 처리
  3. `handleSessionStart()` 함수 호출

```javascript
// main.js:846-872
function handleSessionStart(sessionId, cwd, pid = 0, isTeammate = false, isSubagent = false, initialState = 'Waiting', parentId = null) {
  if (!agentManager) {
    pendingSessionStarts.push({ sessionId, cwd, ts: Date.now(), isTeammate, isSubagent, initialState, parentId });
    debugLog(`[Hook] SessionStart queued: ${sessionId.slice(0, 8)}`);
    return;
  }
  const displayName = cwd ? path.basename(cwd) : 'Agent';
  agentManager.updateAgent({ sessionId, projectPath: cwd, displayName, state: initialState, jsonlPath: null, isTeammate, isSubagent, parentId }, 'http');
  // ... PID 할당 로직
}
```

#### pendingSessionStarts 배열 역할
- **위치**: `E:\projects\pixel-agent-desk-master\main.js:344`
- **목적**: `agentManager`가 초기화되기 전에 도착한 세션 시작 요청을 대기
- **처리**: `app.whenReady()` 이후 `main.js:1015-1020`에서 배치 처리

```javascript
// main.js:1015-1020
while (pendingSessionStarts.length > 0) {
  const { sessionId, cwd, isTeammate, isSubagent, initialState, parentId } = pendingSessionStarts.shift();
  handleSessionStart(sessionId, cwd, 0, isTeammate, isSubagent, initialState, parentId);
}
```

#### agentManager.updateAgent() 호출 시점
- **위치**: `E:\projects\pixel-agent-desk-master\agentManager.js:40-107`
- **조건**: 다음 상황에서 호출됨
  1. SessionStart 훅 수신
  2. UserPromptSubmit (Working 상태)
  3. PreToolUse (Working 상태)
  4. PostToolUse (Thinking 상태)
  5. Stop/TaskCompleted (Done 상태)
  6. SubagentStart/SubagentStop
  7. TeammateIdle
  8. 복구 시나리오

### 1.2 생성 데이터 구조

```javascript
// agentManager.js:70-89
const agentData = {
  id: agentId,                    // 세션 ID
  sessionId: entry.sessionId,
  agentId: entry.agentId,
  slug: entry.slug,
  displayName: formatDisplayName(entry.slug, entry.projectPath),
  projectPath: entry.projectPath,
  jsonlPath: entry.jsonlPath || null,
  isSubagent: entry.isSubagent || false,
  isTeammate: entry.isTeammate || false,
  parentId: entry.parentId || null,
  state: newState,                // Working, Thinking, Done, Waiting, Help, Error
  activeStartTime: now,           // 활성 상태 시작 시간
  lastDuration: 0,                // 마지막 작업 소요 시간
  lastActivity: now,              // 마지막 활동 시간
  source: 'log',                  // 데이터 소스
  timestamp: entry.timestamp || now,
  firstSeen: now,                 // 처음 발견 시간
  updateCount: 1                  // 업데이트 횟수
};
```

---

## 2. PID 추적 방식 (PID Tracking)

### 2.1 sessionPids Map 구조
- **위치**: `E:\projects\pixel-agent-desk-master\main.js:694`
- **구조**: `Map<sessionId, processId>`
- **목적**: 에이전트 세션과 실제 Claude CLI 프로세스 PID 매핑

```javascript
const sessionPids = new Map(); // sessionId → 실제 claude 프로세스 PID
```

### 2.2 PID 할당 메커니즘

#### 방법 1: 훅 데이터에서 직접 수신
- `hook.js:18`에서 `process.ppid`를 통해 Claude CLI PID 수신
- `main.js:856-859`에서 바로 할당

```javascript
// main.js:856-859
if (pid > 0) {
  sessionPids.set(sessionId, pid);
  return;
}
```

#### 방법 2: WMI 쿼리로 동적 할당
- **위치**: `main.js:860-871`
- **방식**: PowerShell로 node.exe 프로세스 중 claude/cli.js를 실행 중인 프로세스 검색
- **로직**: 이미 등록된 PID를 제외하고 새로운 PID 할당

```javascript
// main.js:860-871
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
```

### 2.3 생존 확인 방식

#### process.kill(pid, 0) 기본 확인
- **위치**: `main.js:699-706`
- **목적**: 프로세스 존재 여부 확인 (시그널 전송 없음)
- **장점**: 빠르고 가벼움
- **단점**: 프로세스가 응답하지 않아도 존재하면 true 반환

```javascript
async function checkLivenessTier1(agentId, pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}
```

---

## 3. 생존 확인 메커니즘 (Liveness Checker)

### 3.1 Liveness Checker 개요
- **위치**: `E:\projects\pixel-agent-desk-master\main.js:757-843`
- **주기**: 3초마다 실행 (`INTERVAL = 3000`)
- **유예 시간**: 15초 (`GRACE_MS = 15000`)
- **최대 실패 횟수**: 10회 (약 30초)

### 3.2 3단계 생존 확인 체계

#### Tier 1: 기본 프로세스 존재 확인
- **위치**: `main.js:699-706`
- **방식**: `process.kill(pid, 0)`
- **목적**: 프로세스가 OS에 존재하는지 확인

```javascript
async function checkLivenessTier1(agentId, pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}
```

#### Tier 2: 프로세스 응답성 확인
- **위치**: `main.js:711-724`
- **방식**: PowerShell Get-Process의 Responding 속성 확인
- **목적**: 프로세스가 실제로 동작 중인지 확인

```javascript
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
```

#### Tier 3: 세션 활동 확인 + 복구
- **위치**: `main.js:729-755`
- **방식**: `checkSessionActive()` 함수로 프로세스 트리 확인
- **목적**: JSONL 파일과 프로세스 트리로 세션 활성 상태 확인

```javascript
async function checkLivenessTier3(agentId, pid) {
  return await checkSessionActive(agentId, pid);
}
```

### 3.3 30초 DEAD 판정 로직

```javascript
// main.js:757-843
const INTERVAL = 3000;   // 3초
const GRACE_MS = 15000;  // 등록 후 15초는 스킵
const MAX_MISS = 10;     // 10회 연속 실패 → DEAD (~30초)
const missCount = new Map();

setInterval(async () => {
  for (const agent of agentManager.getAllAgents()) {
    // Grace 기간 내 스킵
    if (agent.firstSeen && Date.now() - agent.firstSeen < GRACE_MS) {
      missCount.delete(agent.id);
      continue;
    }

    const pid = sessionPids.get(agent.id);
    if (!pid) continue;

    // Tier 1 확인
    let alive = await checkLivenessTier1(agent.id, pid);

    // Tier 2 확인
    if (!alive) {
      alive = await checkLivenessTier2(agent.id, pid);
    }

    if (alive) {
      missCount.delete(agent.id);
      // Offline 상태였으면 복구
      if (agent.state === 'Offline') {
        agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live');
      }
    } else {
      const n = (missCount.get(agent.id) || 0) + 1;
      missCount.set(agent.id, n);

      // 3회 실패 (9초) → Offline
      if (n === 3 && agent.state !== 'Offline') {
        agentManager.updateAgent({ ...agent, state: 'Offline' }, 'live');
      }

      // 10회 실패 (30초) → DEAD
      if (n >= MAX_MISS) {
        // 복구 시도 후 실패하면 제거
        const recovered = await attemptAgentRecovery(agent.id, pid);
        if (!recovered) {
          agentManager.removeAgent(agent.id);
          sessionPids.delete(agent.id);
        }
      }
    }
  }
}, INTERVAL);
```

---

## 4. 소멸 및 복구 (Destruction & Recovery)

### 4.1 DEAD 판정 후 제거 로직

#### 조건부 제거 (자식 에이전트 존재 시)
- **위치**: `main.js:804-836`
- **로직**: 활성 자식 에이전트가 있으면 제거하지 않고 상태만 Offline으로 변경

```javascript
// main.js:804-836
if (n >= MAX_MISS) {
  const children = agentManager.getAllAgents().filter(a => a.parentId === agent.id);
  const hasActiveChildren = children.length > 0;

  if (hasActiveChildren) {
    // 자식이 있으면 아바타 유지, 상태만 Offline
    if (agent.state !== 'Offline') {
      agentManager.updateAgent({ ...agent, state: 'Offline' }, 'live');
    }
    debugLog(`[Live-Tier1] ${agent.id.slice(0, 8)} DEAD but keeps for active sub-agents`);
  } else {
    // 복구 시도 (최대 2번)
    const attempts = recoveryAttempts.get(agent.id) || 0;
    if (attempts < 2) {
      recoveryAttempts.set(agent.id, attempts + 1);
      const recovered = await attemptAgentRecovery(agent.id, pid);
      if (recovered) {
        missCount.delete(agent.id);
        continue;
      }
    }
    // 복구 실패 → 제거
    agentManager.removeAgent(agent.id);
    sessionPids.delete(agent.id);
  }
}
```

### 4.2 recoverExistingSessions() 복구 방식
- **위치**: `main.js:602-689`
- **목적**: 앱 재시작 시 활성 세션 복구
- **데이터 소스**: `~/.pixel-agent-desk/state.json`

```javascript
// main.js:602-689
function recoverExistingSessions() {
  const statePath = getPersistedStatePath();
  if (!fs.existsSync(statePath)) return;

  const raw = fs.readFileSync(statePath, 'utf-8');
  const state = JSON.parse(raw);
  const savedAgents = state.agents || [];
  const savedPids = new Map((state.pids || []));

  let recoveredCount = 0;
  for (const agent of savedAgents) {
    const pid = savedPids.get(agent.id);

    // 프로세스 생존 확인
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
      agentManager.updateAgent({ /* agent data */ }, 'recover');
      recoveredCount++;
    }
  }

  // 오프라인 훅 리플레이
  const hooksPath = path.join(os.homedir(), '.pixel-agent-desk', 'hooks.jsonl');
  if (fs.existsSync(hooksPath)) {
    const lines = fs.readFileSync(hooksPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        processHookEvent(data);
      } catch (e) { }
    }
    fs.writeFileSync(hooksPath, ''); // 리플레이 후 비우기
  }
}
```

### 4.3 WMI 쿼리로 세션 복구 과정

#### 복구 시점
1. 앱 재시작 시 `recoverExistingSessions()` 호출
2. PID가 없는 세션의 경우 WMI 쿼리로 PID 재할당 시도
3. `handleSessionStart()`에서 PowerShell로 프로세스 검색

#### 복구 로직
```javascript
// main.js:860-871
const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude*cli.js*' } | Select-Object -ExpandProperty ProcessId`;
const { execFile } = require('child_process');
execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 6000 }, (err, stdout) => {
  if (err || !stdout) return;
  const allPids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
  const registeredPids = new Set(sessionPids.values());
  const newPid = allPids.find(p => !registeredPids.has(p));
  if (newPid) {
    sessionPids.set(sessionId, newPid);
  }
});
```

---

## 5. 렌더러 표시 (Renderer Display)

### 5.1 addAgent() 렌더링 시점
- **위치**: `renderer.js:405-429`
- **트리거**: Main 프로세스에서 'agent-added' 이벤트 수신

```javascript
// renderer.js:405-429
function addAgent(agent) {
  // 중복 체크
  if (document.querySelector(`[data-agent-id="${agent.id}"]`)) {
    return;
  }

  const card = createAgentCard(agent);
  agentGrid.appendChild(card);

  // 전역 데이터 캐시 업데이트
  if (!window.lastAgents) window.lastAgents = [];
  if (!window.lastAgents.some(a => a.id === agent.id)) {
    window.lastAgents.push(agent);
  }

  // 초기 상태 설정
  updateAgentState(agent.id, card, agent);

  // 그리드 레이아웃 업데이트
  updateGridLayout();
  requestDynamicResize();

  console.log(`[Renderer] Agent added: ${agent.displayName} (${agent.id.slice(0, 8)})`);
}
```

### 5.2 아바타 이미지 할당 방식
- **위치**: `renderer.js:292-303`
- **로직**: 에이전트 ID별로 랜덤 아바타 할당 (재사용)

```javascript
// renderer.js:292-303
let assignedAvatar = agentAvatars.get(agent.id);
if (!assignedAvatar && availableAvatars.length > 0) {
  assignedAvatar = availableAvatars[Math.floor(Math.random() * availableAvatars.length)];
  agentAvatars.set(agent.id, assignedAvatar);
} else if (!assignedAvatar) {
  assignedAvatar = idleAvatar || 'avatar_0.png';
}

if (assignedAvatar) {
  character.style.backgroundImage = `url('./public/characters/${assignedAvatar}')`;
}
```

### 5.3 애니메이션 상태 관리

#### 애니메이션 시퀀스
```javascript
// renderer.js:17-22
const ANIM_SEQUENCES = {
  working: { frames: [1, 2, 3, 4], fps: 8, loop: true },
  complete: { frames: [20, 21, 22, 23, 24, 25, 26, 27], fps: 6, loop: true },
  waiting: { frames: [32], fps: 1, loop: true },
  alert: { frames: [0, 31], fps: 4, loop: true }
};
```

#### 상태별 매핑
```javascript
// renderer.js:25-33
const stateConfig = {
  'Working': { anim: 'working', class: 'state-working', label: '⚡ Working...' },
  'Thinking': { anim: 'working', class: 'state-working', label: '💭 Thinking...' },
  'Done': { anim: 'complete', class: 'state-complete', label: '✓ Done!' },
  'Waiting': { anim: 'waiting', class: 'state-waiting', label: '⏳ Waiting...' },
  'Error': { anim: 'alert', class: 'state-alert', label: '⚠️ Error!' },
  'Help': { anim: 'alert', class: 'state-alert', label: '⚠️ Help!' },
  'Offline': { anim: 'waiting', class: 'state-offline', label: '💤 Offline' }
};
```

#### requestAnimationFrame 기반 애니메이션
- **위치**: `renderer.js:39-133`
- **장점**: 성능 최적화, 배터리 절약
- **관리**: `animationManager`가 에이전트별 애니메이션 상태 관리

```javascript
// renderer.js:73-114
loop(agentId) {
  const animation = this.animations.get(agentId);
  if (!animation) return;

  animation.rafId = requestAnimationFrame((currentTime) => {
    if (!this.animations.has(agentId)) return;

    const targetFPS = animation.sequence.fps;
    const frameDuration = 1000 / targetFPS;

    if (currentTime - animation.lastTime >= frameDuration) {
      animation.frameIdx++;

      if (animation.frameIdx >= animation.sequence.frames.length) {
        if (animation.sequence.loop) {
          animation.frameIdx = 0;
        } else {
          this.stop(agentId);
          return;
        }
      }

      // 프레임 그리기
      const frameNum = animation.sequence.frames[animation.frameIdx];
      const col = frameNum % SHEET.cols;
      const row = Math.floor(frameNum / SHEET.cols);
      const x = col * -SHEET.width;
      const y = row * -SHEET.height;
      animation.element.style.backgroundPosition = `${x}px ${y}px`;

      animation.lastTime = currentTime;
    }

    this.loop(agentId);
  });
}
```

---

## 6. 현재 생명주기 관리의 문제점

### 6.1 메모리 누수 위험

#### 문제 1: Map 구조 미정리
- **대상**: `firstPreToolUseDone`, `postToolIdleTimers`, `sessionPids`
- **위치**: `main.js:346-348`
- **문제**: 세션 종료 시 일부 Map만 정리되고 나머지는 누적
- **영향**: 장시간运行 시 메모리 사용량 지속적 증가

```javascript
// main.js:874-893
function cleanupAgentResources(sessionId) {
  firstPreToolUseDone.delete(sessionId);  // ✅ 정리됨

  const timer = postToolIdleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    postToolIdleTimers.delete(sessionId);  // ✅ 정리됨
  }

  sessionPids.delete(sessionId);  // ✅ 정리됨

  // missCount는 startLivenessChecker 내부 스코프라 정리 안됨
}
```

#### 문제 2: Liveness Checker의 missCount Map
- **위치**: `main.js:761` (함수 내부)
- **문제**: 에이전트 제거 후에도 missCount 카운트 유지
- **영향**: 장기 실행 시 Map 크기 무한 증가

### 6.2 PID 추적 정확성

#### 문제 1: WMI 쿼리 지연
- **위치**: `main.js:860-871`
- **문제**: PowerShell 쿼리가 6초 타임아웃까지 걸릴 수 있음
- **영향**: 초기 세션 시작 시 PID 할당 지연

#### 문제 2: PID 중복 할당 위험
- **시나리오**: 동시에 여러 세션 시작 시
- **문제**: `registeredPids` Set이 갱신되기 전에 새 세션이 같은 PID 할당 가능
- **영향**: 잘못된 PID 매핑으로 생존 확인 오류

### 6.3 복구 메커니즘 불완전

#### 문제 1: 오프라인 훅 리플레이 순서
- **위치**: `main.js:664-679`
- **문제**: hooks.jsonl 리플레이가 state.json 복구 후에 실행
- **영향**: 훅 순서가 섞여 상태 불일치 가능

#### 문제 2: 복구 실패 후 재시도 없음
- **위치**: `main.js:818-829`
- **문제**: 복구 시도 2회 실패 후 바로 제거
- **영향**: 일시적 네트워크 오류 등으로 불필요한 에이전트 제거

### 6.4 렌더러 성능

#### 문제 1: 전역 상태 관리 복잡
- **위치**: `renderer.js:36`, `renderer.js:136-138`
- **문제**: `agentStates`, `agentAvatars`, `window.lastAgents` 등 중복 상태
- **영향**: 상태 동기화 오류 가능성

#### 문제 2: 애니메이션 리소스 누수
- **위치**: `renderer.js:116-132`
- **문제**: 애전트 제거 시 `cancelAnimationFrame` 호출되지만 interval 정리 불완전
- **영향**: 백그라운드에서 불필요한 RAF 실행

---

## 7. 개선안 제안

### 7.1 메모리 누수 해결

#### 개선 1: 통합 리소스 정리 함수
```javascript
// 제안: main.js
function cleanupAllAgentResources(sessionId) {
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

  // 4. Liveness 카운터 정리
  if (typeof cleanupLivenessMissCount === 'function') {
    cleanupLivenessMissCount(sessionId);
  }

  // 5. 복구 시도 정리
  recoveryAttempts.delete(sessionId);

  debugLog(`[Cleanup] All resources cleared for ${sessionId.slice(0, 8)}`);
}
```

#### 개선 2: Liveness Checker에 정리 함수 추가
```javascript
// 제안: main.js
function startLivenessChecker() {
  const missCount = new Map();
  const recoveryAttempts = new Map();

  // 외부에서 접근 가능한 정리 함수
  window.cleanupLivenessMissCount = (sessionId) => {
    missCount.delete(sessionId);
    recoveryAttempts.delete(sessionId);
  };

  // ... 기존 로직
}
```

### 7.2 PID 추적 개선

#### 개선 1: PID 할당 큐잉
```javascript
// 제안: main.js
const pidAssignmentQueue = new Map(); // sessionId → resolve 함수

async function assignPidToSession(sessionId) {
  // 이미 할당 중이면 대기
  if (pidAssignmentQueue.has(sessionId)) {
    return await pidAssignmentQueue.get(sessionId);
  }

  const promise = new Promise((resolve) => {
    pidAssignmentQueue.set(sessionId, resolve);

    const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude*cli.js*' } | Select-Object -ExpandProperty ProcessId`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 6000 }, (err, stdout) => {
      pidAssignmentQueue.delete(sessionId);

      if (err || !stdout) {
        resolve(null);
        return;
      }

      const allPids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
      const registeredPids = new Set(sessionPids.values());
      const newPid = allPids.find(p => !registeredPids.has(p));

      if (newPid) {
        sessionPids.set(sessionId, newPid);
        resolve(newPid);
      } else {
        resolve(null);
      }
    });
  });

  return await promise;
}
```

#### 개선 2: PID 검증 메커니즘
```javascript
// 제안: main.js
async function validatePidAssignment(sessionId, pid) {
  // 프로세스가 실제로 해당 세션의 것인지 확인
  const isActive = await checkSessionActive(sessionId, pid);
  if (!isActive) {
    sessionPids.delete(sessionId);
    return false;
  }
  return true;
}
```

### 7.3 복구 메커니즘 강화

#### 개선 1: 순서 보장 복구
```javascript
// 제안: main.js
async function recoverExistingSessions() {
  // 1. 먼저 오프라인 훅 리플레이
  const hooksPath = path.join(os.homedir(), '.pixel-agent-desk', 'hooks.jsonl');
  if (fs.existsSync(hooksPath)) {
    const lines = fs.readFileSync(hooksPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        processHookEvent(data);
      } catch (e) { }
    }
    fs.writeFileSync(hooksPath, '');
  }

  // 2. 그 다음 state.json 복구
  const statePath = getPersistedStatePath();
  if (fs.existsSync(statePath)) {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    // ... 복구 로직
  }
}
```

#### 개선 2: 지수 백오프 복구
```javascript
// 제안: main.js
async function attemptAgentRecovery(agentId, pid, attempt = 0) {
  const maxAttempts = 5;
  const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // 최대 30초

  if (attempt >= maxAttempts) {
    debugLog(`[Live-Tier3] Recovery failed after ${maxAttempts} attempts for ${agentId.slice(0, 8)}`);
    return false;
  }

  const isActive = await checkLivenessTier3(agentId, pid);
  if (isActive) {
    const agent = agentManager.getAgent(agentId);
    if (agent) {
      agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live-recreate');
      return true;
    }
  }

  // 지수 백오프 후 재시도
  await new Promise(resolve => setTimeout(resolve, backoffMs));
  return attemptAgentRecovery(agentId, pid, attempt + 1);
}
```

### 7.4 렌더러 최적화

#### 개선 1: 상태 관리 통합
```javascript
// 제안: renderer.js
class AgentStateManager {
  constructor() {
    this.agents = new Map(); // agentId -> { state, anim, avatar, etc. }
  }

  setAgentState(agentId, state) {
    const existing = this.agents.get(agentId) || {};
    this.agents.set(agentId, { ...existing, ...state });
  }

  getAgentState(agentId) {
    return this.agents.get(agentId);
  }

  removeAgent(agentId) {
    const state = this.agents.get(agentId);
    if (state) {
      // 모든 리소스 정리
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (state.interval) clearInterval(state.interval);
      if (state.timerInterval) clearInterval(state.timerInterval);
    }
    this.agents.delete(agentId);
  }
}

const agentStateManager = new AgentStateManager();
```

#### 개선 2: 애니메이션 풀링
```javascript
// 제안: renderer.js
class AnimationPool {
  constructor() {
    this.pool = new Map(); // animName -> [{ element, rafId, inUse }]
  }

  start(agentId, element, animName) {
    this.stop(agentId);

    const sequence = ANIM_SEQUENCES[animName];
    if (!sequence) return;

    const animation = {
      agentId,
      element,
      animName,
      sequence,
      frameIdx: 0,
      lastTime: performance.now(),
      rafId: null
    };

    this.pool.set(agentId, animation);
    this.loop(agentId);
  }

  stop(agentId) {
    const animation = this.pool.get(agentId);
    if (animation && animation.rafId) {
      cancelAnimationFrame(animation.rafId);
    }
    this.pool.delete(agentId);
  }

  cleanup() {
    for (const [agentId, animation] of this.pool.entries()) {
      if (animation.rafId) {
        cancelAnimationFrame(animation.rafId);
      }
    }
    this.pool.clear();
  }
}

const animationPool = new AnimationPool();
```

---

## 8. 결론

### 8.1 현재 상태 요약
- **장점**: 3단계 생존 확인, 자동 복구, 영속화 등 견고한 아키텍처
- **단점**: 메모리 누수 위험, PID 추적 정확성, 복구 메커니즘 개선 여지

### 8.2 우선순위별 개선 작업

#### P0 (긴급)
1. 메모리 누수 해결: 통합 리소스 정리 함수 구현
2. Liveness Checker missCount 정리 메커니즘 추가

#### P1 (중요)
1. PID 추적 개선: 할당 큐잉 및 검증 메커니즘
2. 복구 순서 보장: 오프라인 훅 먼저 리플레이

#### P2 (개선)
1. 지수 백오프 복구 전략
2. 렌더러 상태 관리 통합
3. 애니메이션 풀링 도입

### 8.3 모니터링 지표
- **메모리 사용량**: Map 구조 크기 모니터링
- **PID 할당 성공률**: WMI 쿼리 성능 추적
- **복구 성공률**: Tier 3 복구 시도 성공 비율
- **에이전트 평균 수명**: 생성부터 소멸까지의 시간

---

## 참고 문서
- `E:\projects\pixel-agent-desk-master\main.js` - 메인 프로세스 로직
- `E:\projects\pixel-agent-desk-master\agentManager.js` - 에이전트 관리자
- `E:\projects\pixel-agent-desk-master\renderer.js` - 렌더러 로직
- `E:\projects\pixel-agent-desk-master\utils.js` - 유틸리티 함수
- `E:\projects\pixel-agent-desk-master\hook.js` - 훅 스크립트
- `E:\projects\pixel-agent-desk-master\sessionend_hook.js` - 세션 종료 훅

---

**작성일**: 2026-03-05
**버전**: 1.0
**작성자**: Claude Code (Sonnet 4.6)
