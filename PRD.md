# 📋 PRD: Pixel Agent Desk v2

## 목표
Claude CLI 사용 중인 세션을 픽셀 캐릭터로 시각화

## 핵심 기능
1. **JSONL 파일 감시**: `~/.claude/projects/*/` 폴더의 `.jsonl` 파일 실시간 모니터링
2. **멀티 에이전트**: 여러 Claude CLI 세션 동시 표시
3. **상태 시각화**: Working/Done/Waiting/Error 상태에 따른 애니메이션
4. **터미널 포커스**: 에이전트 클릭 시 해당 터미널로 포커스

## 상태 정의
| 상태 | 조건 | 애니메이션 |
|------|------|-----------|
| Working | `stop_reason` 없음 | 일하는 포즈 (frames 1-4) |
| Done | `stop_reason: "end_turn"` | 춤추는 포즈 (frames 20-27) |
| Waiting | 초기 상태 | 앉아 있는 포즈 (frame 32) |
| Error | 에러 발생 | 경고 포즈 (frames 0, 31) |

## 아키텍처
```
JSONL 파일 (fs.watch)
    ↓
jsonlParser (상태 파싱)
    ↓
agentManager (에이전트 관리)
    ↓
IPC → renderer (UI 표시)
```

## 파일 구조
- `main.js`: Electron 메인 프로세스
- `logMonitor.js`: JSONL 파일 감시
- `jsonlParser.js`: 로그 파싱
- `agentManager.js`: 에이전트 상태 관리
- `processWatcher.js`: 프로세스 감지 (터미널 포커스용)
- `renderer.js`: UI 렌더링
- `preload.js`: IPC 브릿지
- `styles.css`: 스타일

## 구현 현황
- ✅ JSONL 파일 감시
- ✅ 상태 파싱
- ✅ 멀티 에이전트 UI
- ✅ 애니메이션
- ⏸️ 프로세스 감지 (WorkingDirectory null 문제)

## 해결해야 할 문제
1. 프로세스 감지: `Get-CimInstance`로 가져온 node.exe의 WorkingDirectory가 null임
2. 해결책: CommandLine에서 CWD 추출 또는 다른 방법 모색

## 실행 방법
```bash
npm install
npm start
```

## 테스트 방법
1. 터미널에서 `claude` 실행
2. 아무 말이나 입력
3. 에이전트 카드 표시 확인
