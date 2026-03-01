const container = document.getElementById('container');
const speechBubble = document.getElementById('speech-bubble');

// 워킹 시간 관련 변수
let workingStartTime = null;
let workingTimer = null;
let isWorkingState = false;
let finalWorkingTime = null; // 최종 워킹 시간 저장

// 상태 설정 통합 (클래스 + 라벨)
const stateConfig = {
  'Start': { class: 'state-start', label: 'Starting...' },
  'UserPromptSubmit': { class: 'state-thinking', label: 'Working...' },
  'PostToolUse': { class: 'state-thinking', label: 'Working...' },
  'PreToolUse': { class: 'state-working', label: 'Working...' },
  'Stop': { class: 'state-complete', label: 'Done!' },
  'Error': { class: 'state-error', label: 'Error!' },
  'Notification': { class: 'state-alert', label: 'Notification' },
  'Idle': { class: 'state-Idle', label: 'Idle' },
  'Thinking': { class: 'state-thinking', label: 'Working...' },
  'Working': { class: 'state-working', label: 'Working...' },
  'Complete': { class: 'state-complete', label: 'Complete!' },
  'Alert': { class: 'state-alert', label: 'Alert!' }
};

// 상태 업데이트
function updateState(state, message) {
  console.log(`상태 업데이트: ${state} -> ${stateConfig[state]?.label}`);

  // 워킹 상태 체크 (UserPromptSubmit, PreToolUse, PostToolUse, Thinking, Working)
  const workingStates = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Thinking', 'Working'];
  if (workingStates.includes(state)) {
    if (!workingStartTime) {
      workingStartTime = Date.now();
      isWorkingState = true;
      startWorkingTimer();
      // 워킹 상태 시작 시 첫 텍스트 설정
      speechBubble.textContent = 'Working...';
    }
  } else {
    // 워킹 상태가 끝날 때 최종 시간 저장
    if (isWorkingState && workingStartTime) {
      finalWorkingTime = Math.floor((Date.now() - workingStartTime) / 1000);
    }
    stopWorkingTimer();
    workingStartTime = null;
    isWorkingState = false;
  }

  // 이전 상태 클래스 제거
  container.className = 'container';

  // 새로운 상태 클래스 추가
  const config = stateConfig[state] || stateConfig['Complete'];
  container.classList.add(config.class);

  // Done 상태일 때 최종 시간 표시
  if (state === 'Stop' || state === 'Complete') {
    if (finalWorkingTime && finalWorkingTime > 0) {
      speechBubble.textContent = `Done! (${formatWorkingTime(finalWorkingTime)})`;
    } else {
      speechBubble.textContent = 'Done!';
    }
  } else if (!isWorkingState) {
    // 워킹 상태가 아닌 다른 상태일 때
    speechBubble.textContent = config.label;
  }
}

// 워킹 타이머 시작
function startWorkingTimer() {
  workingTimer = setInterval(() => {
    if (workingStartTime && isWorkingState) {
      const elapsed = Date.now() - workingStartTime;
      const seconds = Math.floor(elapsed / 1000);
      speechBubble.textContent = `Working... ${formatWorkingTime(seconds)}`;
    }
  }, 1000);
}

// 워킹 타이머 중지
function stopWorkingTimer() {
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
}

// 워킹 시간 포맷팅
function formatWorkingTime(seconds) {
  if (seconds === 0) {
    return '';
  } else if (seconds < 10) {
    return `${seconds}초`;
  } else if (seconds < 60) {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  } else {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}

// IPC로 상태 업데이트 수신
if (window.electronAPI) {
  window.electronAPI.onStateUpdate((data) => {
    const { state, message } = data;
    updateState(state, message);
  });
}

// 백그라운드에서 애니메이션 일시 정지
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.body.classList.add('paused');
  } else {
    document.body.classList.remove('paused');
  }
});
