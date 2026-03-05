# Claude Code 훅 데이터 파싱 분석 보고서

## 개요

본 보고서는 Pixel Agent Desk 애플리케이션에서 Claude Code CLI의 훅 데이터를 수신, 파싱, 처리하는 전체 흐름을 분석하고 현재 파싱 방식의 취약점과 개선 필요성을 정리합니다.

---

## 1. 훅 데이터 흐름

### 1.1 전체 데이터 파이프라인

```
Claude CLI
    ↓ (stdin)
hook.js
    ↓ (JSON.parse → _pid/_timestamp 추가 → JSON.stringify)
    ↓ (HTTP POST to 127.0.0.1:47821/hook)
main.js (HTTP Server)
    ↓ (JSON.parse → Ajv Schema Validation)
    ↓ (processHookEvent)
AgentManager
    ↓ (IPC Communication)
renderer.js
    ↓ (UI Update)
```

### 1.2 단계별 데이터 변환

#### 단계 1: Claude CLI → hook.js

**입력 (stdin):**
```json
{
  "hook_event_name": "SessionStart",
  "session_id": "ses_abc123...",
  "cwd": "/path/to/project"
}
```

**hook.js 처리 (lines 14-19):**
```javascript
const data = JSON.parse(Buffer.concat(chunks).toString());
data._pid = process.ppid;        // Claude 프로세스 PID 추가
data._timestamp = Date.now();    // 타임스탬프 추가
```

**출력 (HTTP POST body):**
```json
{
  "hook_event_name": "SessionStart",
  "session_id": "ses_abc123...",
  "cwd": "/path/to/project",
  "_pid": 12345,
  "_timestamp": 1677630000000
}
```

#### 단계 2: hook.js → main.js

**HTTP 수신 (main.js lines 542-574):**
```javascript
let body = '';
req.on('data', chunk => { body += chunk; });
req.on('end', () => {
    const data = JSON.parse(body);
    // Ajv 검증
    const isValid = validateHook(data);
    processHookEvent(data);
});
```

---

## 2. JSON 파싱 지점

### 2.1 주요 파싱 위치

| 위치 | 파일 | 라인 | 목적 | 에러 처리 |
|------|------|------|------|----------|
| **stdin 수신** | hook.js | 16 | Claude CLI 데이터 파싱 | `process.exit(0)` (silent) |
| **HTTP 수신** | main.js | 549 | hook.js 전송 데이터 파싱 | errorHandler.capture(E002) |
| **복구 모드** | main.js | 613 | state.json 복구 | errorHandler.capture(E009) |
| **복구 모드** | main.js | 672 | hooks.jsonl 리플레이 | `try-catch` 무시 |
| **세션 종료** | sessionend_hook.js | 14, 35 | transcript_path 파싱 | 로그 기록 후 exit |

### 2.2 각 파싱 지점 상세 분석

#### 2.2.1 hook.js stdin 파싱 (최초 진입점)

```javascript
// hook.js lines 14-19
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
    try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        data._pid = process.ppid;
        data._timestamp = Date.now();
        // ...
    } catch (e) {
        process.exit(0);  // silent failure - 로그 없음
    }
});
```

**취약점:**
- 파싱 실패 시 로그를 남기지 않음
- 원인 불명의 데이터 손실 가능
- `_pid`가 0인 경우 Claude CLI가 아닌 다른 프로세스에서 호출되었을 수 있음

#### 2.2.2 main.js HTTP 파싱 (메인 파싱 지점)

```javascript
// main.js lines 548-572
try {
    const data = JSON.parse(body);

    // Ajv 스키마 검증
    const isValid = validateHook(data);
    if (!isValid) {
        errorHandler.capture(new Error('Invalid hook data'), {
            code: 'E010',
            category: 'VALIDATION',
            severity: 'WARNING',
            details: validateHook.errors
        });
        return;
    }

    processHookEvent(data);
} catch (e) {
    errorHandler.capture(e, {
        code: 'E002',
        category: 'PARSE',
        severity: 'WARNING'
    });
}
```

**장점:**
- Ajv JSON Schema 검증으로 구조적 무결성 보장
- 에러 핸들러를 통한 체계적 오류 기록

**취약점:**
- `body`가 빈 문자열인 경우 `JSON.parse('')`가 SyntaxError 발생
- 대용량 페이로드에 대한 메모리 관리 부재
- 문자열 인코딩 검증 없음 (UTF-8 가정)

#### 2.2.3 복구 메커니즘 파싱

**state.json 복구 (main.js lines 612-613):**
```javascript
const raw = fs.readFileSync(statePath, 'utf-8');
const state = JSON.parse(raw);
```

**hooks.jsonl 리플레이 (main.js lines 672-674):**
```javascript
for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const data = JSON.parse(line);
        processHookEvent(data);
    } catch (e) { }  // Silent failure
}
```

**취약점:**
- state.json 손상 시 애플리케이션 복구 불가
- hooks.jsonl의 불량 라인은 조용히 무시됨
- 부분 복구에 대한 상태 추적 부재

---

## 3. 데이터 검증

### 3.1 Ajv JSON Schema (main.js lines 495-532)

```javascript
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
        session_id: { type: 'string' },
        sessionId: { type: 'string' },  // 중복 필드 (호환성)
        cwd: { type: 'string' },
        state: { type: 'string' },
        tool: { type: 'string' },
        _pid: { type: 'number' },
        _timestamp: { type: 'number' }
    },
    additionalProperties: true  // 모든 추가 필드 허용
};
```

**검증 범위:**
- ✅ 필수 필드 존재 여부 (`hook_event_name`)
- ✅ 이벤트 이름 유효성 (enum)
- ✅ 필드 타입 검증

**검증 누락:**
- ❌ `session_id` 포맷 검증 (UUID/Snowflake 등)
- ❌ `_pid` 값 범위 검증 (0 < pid < 2^32)
- ❌ `_timestamp` 합리성 검증 (현재 시간 ±1시간)
- ❌ `cwd` 경로 존재성 검증
- ❌ 중복 훅 방지 (idempotency)
- ❌ 페이로드 크기 제한

### 3.2 processHookEvent 내부 검증 (main.js lines 369-489)

```javascript
function processHookEvent(data) {
    const event = data.hook_event_name;
    const sessionId = data.session_id || data.sessionId;
    if (!sessionId) return;  // silent return

    // ... switch 문으로 이벤트 처리
}
```

**검증:**
- `sessionId` 필드 존재성 검증
- 없는 경우 조용히 반환

---

## 4. 에러 처리

### 4.1 에러 코드 체계

| 코드 | 카테고리 | 심각도 | 설명 |
|------|----------|--------|------|
| E002 | PARSE | WARNING | JSON 파싱 실패 |
| E007 | FILE_IO | WARNING | hooks.jsonl 리플레이 실패 |
| E009 | FILE_IO | WARNING | state.json 읽기 실패 |
| E010 | VALIDATION | WARNING | Ajv 스키마 검증 실패 |

### 4.2 에러 핸들러 동작 (errorHandler.js)

**캡처 프로세스:**
```javascript
async capture(error, context = {}) {
    const errorContext = this.normalize(error, context);

    // 중복 제거 (5초 윈도우)
    const dedupKey = `${errorContext.code}:${errorContext.message}`;
    if (this.deduplicationSet.has(dedupKey)) {
        return errorContext;
    }

    await this.logToFile(errorContext);
    this.sendToRenderer(errorContext);
}
```

**특징:**
- 중복 에러 필터링 (5초 윈도우)
- 비동기 로그 기록
- Renderer 프로세스로 UI 통지

**한계:**
- 파싱 에러의 원본 데이터 보존 안 함
- 재시도 메커니즘 없음
- 에러 통계 집계 기능 부재

---

## 5. processHookEvent 상태 전이 분석

### 5.1 훅 타입별 데이터 추출

| 훅 이벤트 | sessionId 추출 | cwd 추출 | 상태 전이 |
|-----------|----------------|----------|-----------|
| SessionStart | `data.session_id \|\| data.sessionId` | `data.cwd` | 생성 |
| SessionEnd | `data.session_id \|\| data.sessionId` | - | 제거 |
| UserPromptSubmit | `data.session_id \|\| data.sessionId` | - | → Thinking |
| PreToolUse | `data.session_id \|\| data.sessionId` | - | → Working |
| PostToolUse | `data.session_id \|\| data.sessionId` | - | → Thinking |
| PostToolUseFailure | `data.session_id \|\| data.sessionId` | - | → Help |
| SubagentStart | `data.subagent_session_id \|\| data.agent_id` | `data.cwd` | 생성 (서브) |
| SubagentStop | `data.subagent_session_id \|\| data.agent_id` | - | 제거 (서브) |
| TeammateIdle | `data.session_id \|\| data.sessionId` | `data.cwd` | → Waiting |

### 5.2 상태 전이 다이어그램

```
                    ┌─────────────────┐
                    │  SessionStart   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
        ┌───────────┤   Waiting       │◄───────┐
        │           └────────┬────────┘        │
        │                    │                 │
        │                    │ UserPromptSubmit│
        │                    ▼                 │
        │           ┌─────────────────┐        │
        │  ┌────────┤   Thinking      │        │
        │  │        └────────┬────────┘        │
        │  │                 │                 │
        │  │                 │ PreToolUse      │
        │  │                 ▼                 │
        │  │        ┌─────────────────┐        │
        │  │        │    Working      │        │
        │  │        └────────┬────────┘        │
        │  │                 │                 │
        │  │     PostToolUse │                 │ PostToolUseFailure
        │  │                 ▼                 ▼
        │  │        ┌─────────────────┐   ┌─────────┐
        │  └────────┤   Thinking      │   │  Help   │
        │           └────────┬────────┘   └─────────┘
        │                    │
        │                    │ TaskCompleted/Stop
        │                    ▼
        │           ┌─────────────────┐
        └───────────┤      Done       │
                    └────────┬────────┘
                             │
                             │ SessionEnd
                             ▼
                    ┌─────────────────┐
                    │    Removed      │
                    └─────────────────┘
```

### 5.3 특수한 상태 전이 로직

**PreToolUse 무시 로직 (main.js lines 427-429):**
```javascript
if (!firstPreToolUseDone.has(sessionId)) {
    firstPreToolUseDone.set(sessionId, true);
    debugLog(`[Hook] PreToolUse ignored (first = session init)`);
}
```
- 첫 번째 PreToolUse는 세션 초기화 탐색으로 간주하여 무시
- UserPromptSubmit 이벤트가 누락될 때를 대비한 보험

**Idle 타이머 기반 Done 전이 (main.js lines 353-367):**
```javascript
function scheduleIdleDone(sessionId) {
    const timer = setTimeout(() => {
        const agent = agentManager.getAgent(sessionId);
        if (agent && agent.state === 'Working') {
            agentManager.updateAgent({ ...agent, sessionId, state: 'Done' }, 'hook');
        }
    }, POST_TOOL_IDLE_MS);  // 도구 실행 완료 후 30초 대기
}
```
- PostToolUse 후 30초 동안 다른 이벤트 없으면 자동으로 Done 전이
- 응답 완료 감지 실패에 대한 방어 메커니즘

---

## 6. 복구 메커니즘

### 6.1 state.json 복구

**저장 (main.js lines 588-600):**
```javascript
function savePersistedState() {
    const agents = agentManager.getAllAgents();
    const state = {
        agents: agents,
        pids: Array.from(sessionPids.entries())
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}
```

**복구 (main.js lines 602-661):**
```javascript
function recoverExistingSessions() {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);

    for (const agent of savedAgents) {
        const pid = savedPids.get(agent.id);

        // 프로세스 생사 확인
        try {
            process.kill(pid, 0);  // 시그널 0 = 생사 확인만
            isAlive = true;
        } catch (e) {
            isAlive = false;
        }

        if (isAlive) {
            agentManager.updateAgent({ ...agent }, 'recover');
        }
    }
}
```

**특징:**
- 애플리케이션 종료 전에 활성 세션을 JSON으로 직렬화
- 재시작 시 PID로 프로세스 생사 확인 후 복구

**취약점:**
- state.json 파일 손상 시 완전 복구 불가
- 부분 복구에 대한 롤백 메커니즘 없음
- 파일 동시성 제어 없음 (fs.writeFileSync는 원자적이지 않음)

### 6.2 hooks.jsonl 리플레이

**오프라인 로그 기록 (hook.js lines 22-26):**
```javascript
const dir = path.join(os.homedir(), '.pixel-agent-desk');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify(data) + '\n', 'utf-8');
```

**리플레이 (main.js lines 664-688):**
```javascript
const hooksPath = path.join(os.homedir(), '.pixel-agent-desk', 'hooks.jsonl');
const lines = fs.readFileSync(hooksPath, 'utf-8').split('\n');
for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const data = JSON.parse(line);
        processHookEvent(data);
    } catch (e) { }  // 불량 라인 무시
}

// 리플레이 완료 후 파일 비우기
fs.writeFileSync(hooksPath, '');
```

**특징:**
- Pixel Agent Desk가 종료된 상태에서도 훅 이벤트 보존
- 재시작 후 순차적 재처리

**취약점:**
- 불량 JSON 라인은 조용히 손실됨
- 리플레이 도중 오류 발생 시 파일이 비워지어 데이터 손실 가능
- 중복 리플레이 방지 메커니즘 없음

---

## 7. 현재 파싱 방식의 취약점

### 7.1 심각도: 높음 (Critical)

#### 1. 원시 파싱 에러의 무시 (hook.js)
```javascript
catch (e) {
    process.exit(0);  // 로그 없음
}
```
- **문제:** Claude CLI에서 전달된 데이터가 손상되어도 원인 파악 불가
- **영향:** 디버깅 불가능한 데이터 손실
- **개선 필요성:** ★★★★★

#### 2. 이중 sessionId 필드에 대한 일관성 부재
```javascript
const sessionId = data.session_id || data.sessionId;
```
- **문제:** 두 필드가 모두 존재하거나 값이 다른 경우 결정적 동작 보장 불가
- **영향:** 세션 중복 생성 또는 업데이트 누락
- **개선 필요성:** ★★★★★

#### 3. state.json 손상 시 완전 복구 불가
- **문제:** 단일 파일에 모든 상태 저장 → JSON 손상 시 전체 손실
- **영향:** 애플리케이션 재시작 시 모든 세션 정보 소실
- **개선 필요성:** ★★★★☆

### 7.2 심각도: 중간 (High)

#### 4. Ajv 검증의 불충분성
- **누락된 검증:**
  - sessionId 포맷 (UUID/Snowflake)
  - _pid 범위 (유효한 PID)
  - _timestamp 합리성 (미래/과거 시각)
  - 페이로드 크기 제한
- **영향:** 잘못된 데이터가 시스템에 진입
- **개선 필요성:** ★★★★☆

#### 5. hooks.jsonl 리플레이의 데이터 손실 위험
```javascript
try {
    const data = JSON.parse(line);
    processHookEvent(data);
} catch (e) { }  // 불량 라인 무시
```
- **문제:** 부분적으로 손상된 파일에서 정상 라인도 손실 가능
- **영향:** 훅 이벤트 유실 → 상태 불일치
- **개선 필요성:** ★★★★☆

#### 6. PID 검증 부재
```javascript
data._pid = process.ppid;  // 0일 수 있음
```
- **문제:** _pid가 0이거나 유효하지 않은 경우 감지 안 함
- **영향:** 잘못된 프로세스 추적
- **개선 필요성:** ★★★☆☆

### 7.3 심각도: 낮음 (Medium)

#### 7. 문자열 인코딩 가정
- **문제:** UTF-8 가정, 다른 인코딩 처리 안 함
- **영향:** 비영어권 경로에서 깨짐 가능
- **개선 필요성:** ★★★☆☆

#### 8. 타임스탬프 검증 부재
- **문제:** 미래 시각이나 부정확한 시간 허용
- **영향:** 이벤트 순서 오류 가능
- **개선 필요성:** ★★☆☆☆

---

## 8. 개선 권장사항

### 8.1 단기 개선 (즉시 필요)

1. **hook.js 파싱 에러 로깅**
   ```javascript
   } catch (e) {
       fs.appendFileSync('hook_errors.log', `${Date.now()}|${e.message}|${raw}\n`);
       process.exit(1);  // 비정상 종료로 알림
   }
   ```

2. **sessionId 필드 통일**
   ```javascript
   // 명시적 우선순위와 로깅
   const sessionId = data.sessionId || data.session_id;
   if (data.session_id && data.sessionId && data.session_id !== data.sessionId) {
       debugLog(`[Hook] Conflicting sessionIds: ${data.session_id} vs ${data.sessionId}`);
   }
   ```

3. **state.json 백업 메커니즘**
   ```javascript
   // 쓰기 전 백업
   if (fs.existsSync(statePath)) {
       fs.copyFileSync(statePath, `${statePath}.bak`);
   }
   ```

### 8.2 중기 개선 (다음 버전)

1. **향상된 Ajv 스키마**
   ```javascript
   session_id: {
       type: 'string',
       pattern: '^ses_[a-zA-Z0-9]{20,}$',  // 예: ses_abc123...
       minLength: 10
   },
   _pid: {
       type: 'number',
       minimum: 1,
       maximum: 4294967295  // 2^32 - 1
   },
   _timestamp: {
       type: 'number',
       minimum: Date.now() - 3600000,  // 1시간 전
       maximum: Date.now() + 60000      // 1분 후
   }
   ```

2. **hooks.jsonl 복원력 강화**
   ```javascript
   // 불량 라인을 별도 파일로 보존
   catch (e) {
       fs.appendFileSync('hooks_failed.jsonl', line + '\n');
   }
   ```

3. **페이로드 크기 제한**
   ```javascript
   const MAX_BODY_SIZE = 10 * 1024 * 1024;  // 10MB
   let body = '';
   req.on('data', chunk => {
       body += chunk;
       if (body.length > MAX_BODY_SIZE) {
           res.writeHead(413); res.end();
           req.destroy();
       }
   });
   ```

### 8.3 장기 개선 (아키텍처)

1. **이중 저장소 패턴**
   - state.json + WAL (Write-Ahead Log)
   - 복구 시 WAL로 최신 상태 복구 후 state.json으로 스냅샷

2. **메시지 큐 도입**
   - 메모리 내 큐로 순서 보장
   - 영구성을 위한 디스크 큐

3. **스키마 버전 관리**
   - 훅 데이터 버전 필드 추가
   - 하위 호환성 있는 파서

---

## 9. 결론

### 9.1 현재 상태 요약

| 항목 | 현재 상태 | 점수 |
|------|----------|------|
| 파싱 안정성 | 기본적이나 에러 무시 취약점 | 6/10 |
| 데이터 검증 | Ajv 기본 검증만 수행 | 5/10 |
| 에러 처리 | 체계적이나 복구력 부족 | 6/10 |
| 복구 메커니즘 | 단일 파일 의존, 취약 | 4/10 |
| 로깅 | 일부 영역에서 부족 | 5/10 |

### 9.2 우선순위별 개선 로드맵

**Phase 1 (긴급, 1주 이내):**
- hook.js 파싱 에러 로깅
- sessionId 필드 통일
- state.json 백업

**Phase 2 (중요, 1달 이내):**
- 향상된 Ajv 스키마
- hooks.jsonl 복원력 강화
- 페이로드 크기 제한

**Phase 3 (장기, 3달 이내):**
- 이중 저장소 패턴
- 메시지 큐 도입
- 스키마 버전 관리

### 9.3 최종 권장사항

현재 파싱 시스템은 기본 기능은 수행하지만, **데이터 손실에 대한 복원력이 크게 부족**합니다. 특히 hook.js에서의 silent failure와 state.json의 단일 실패점(SPOF)은 즉시 개선이 필요합니다.

**개선 투자 대비 효과:**
- 단기 개선: 작업량 낮음, 효과 큼 ★★★★★
- 중기 개선: 작업량 중간, 효과 중간 ★★★★☆
- 장기 개선: 작업량 높음, 효과 큼 ★★★★★

---

## 부록 A: 훅 데이터 예제

### A.1 SessionStart

```json
{
  "hook_event_name": "SessionStart",
  "session_id": "ses_abc123def456...",
  "cwd": "/Users/dev/project",
  "_pid": 12345,
  "_timestamp": 1677630000000
}
```

### A.2 PreToolUse

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "ses_abc123def456...",
  "tool": "Bash.run",
  "cwd": "/Users/dev/project",
  "_pid": 12345,
  "_timestamp": 1677630100000
}
```

### A.3 SubagentStart

```json
{
  "hook_event_name": "SubagentStart",
  "session_id": "ses_parent...",
  "subagent_session_id": "ses_subagent...",
  "cwd": "/Users/dev/project",
  "_pid": 12345,
  "_timestamp": 1677630200000
}
```

---

## 부록 B: 테스트 시나리오

### B.1 파싱 실패 테스트

```bash
# 잘못된 JSON 전송
echo '{"hook_event_name": "SessionStart", "session_id":}' | node hook.js

# 예상: 에러 로그 기록 + 비정상 종료
# 실제: 조용히 종료
```

### B.2 복구 테스트

```bash
# state.json 손상
echo "invalid json" > ~/.pixel-agent-desk/state.json

# 앱 재시작
npm start

# 예상: 복구 실패 메시지
# 실제: 복구 로그 후 빈 상태로 시작
```

### B.3 복구력 테스트

```bash
# hooks.jsonl에 불량 라인 추가
echo '{"invalid": json}' >> ~/.pixel-agent-desk/hooks.jsonl

# 앱 재시작
npm start

# 예상: 불량 라인을 보존하고 나머지 리플레이
# 실제: 불량 라인 조용히 무시
```

---

**문서 버전:** 1.0
**생성일:** 2026-03-05
**분석자:** Claude (Sonnet 4.6)
**프로젝트:** Pixel Agent Desk
**대상 코드베이스:** commit d2bede2 (PRD v5.2.1)
