/**
 * Multi-Agent Manager
 * - P2-10: 상태 변경 시에만 이벤트 emit
 * - 표시 이름 개선: slug 없을 경우 cwd basename 사용
 */

const EventEmitter = require('events');
const path = require('path');
const { formatSlugToDisplayName } = require('./utils');

class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this.config = {
      maxAgents: 10,
      idleTimeout: 10 * 60 * 1000,
      cleanupInterval: 60 * 1000
    };
    this.cleanupInterval = null;
  }

  start() {
    this.cleanupInterval = setInterval(() => this.cleanupIdleAgents(), this.config.cleanupInterval);
    console.log('[AgentManager] Started');
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.agents.clear();
    console.log('[AgentManager] Stopped');
  }

  /**
   * 에이전트 업데이트 또는 추가
   */
  updateAgent(entry, source = 'log') {
    const agentId = entry.sessionId || entry.agentId || entry.uuid || 'unknown';
    const now = Date.now();
    const existingAgent = this.agents.get(agentId);

    if (!existingAgent && this.agents.size >= this.config.maxAgents) {
      console.log(`[AgentManager] Max agents reached (${this.config.maxAgents})`);
      return null;
    }

    const prevState = existingAgent ? existingAgent.state : null;
    let newState = entry.state;
    if (!newState) newState = prevState || 'Done'; // 초기 상태는 'Done'으로 설정

    let activeStartTime = existingAgent ? existingAgent.activeStartTime : now;
    let lastDuration = existingAgent ? existingAgent.lastDuration : 0;

    // 활성 상태 진입 시 (Done/Error/Help/Waiting -> Working/Thinking)
    const isPassive = (s) => s === 'Done' || s === 'Help' || s === 'Error' || s === 'Waiting';
    const isActive = (s) => s === 'Working' || s === 'Thinking';

    if (isActive(newState) && (isPassive(prevState) || !existingAgent)) {
      activeStartTime = now;
    }

    // 다시 Done으로 돌아갈 때, 마지막 소요 시간 저장
    if (newState === 'Done' && existingAgent && isActive(prevState)) {
      lastDuration = now - activeStartTime;
    }

    const agentData = {
      id: agentId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      slug: entry.slug,
      displayName: this.formatDisplayName(entry.slug, entry.projectPath),
      projectPath: entry.projectPath,
      jsonlPath: entry.jsonlPath || (existingAgent ? existingAgent.jsonlPath : null),
      state: newState,
      activeStartTime,
      lastDuration,
      lastActivity: now, // 활동 시간은 즉시 갱신
      source,
      timestamp: entry.timestamp || now,
      firstSeen: existingAgent ? existingAgent.firstSeen : now,
      updateCount: existingAgent ? existingAgent.updateCount + 1 : 1
    };

    this.agents.set(agentId, agentData);

    if (!existingAgent) {
      this.emit('agent-added', agentData);
      console.log(`[AgentManager] Agent added: ${agentData.displayName} (${newState})`);
    } else if (newState !== prevState) {
      this.emit('agent-updated', agentData);
      console.log(`[AgentManager] ${agentData.displayName}: ${prevState} → ${newState}`);
    }

    return agentData;
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.agents.delete(agentId);
    this.emit('agent-removed', { id: agentId, displayName: agent.displayName });
    console.log(`[AgentManager] Removed: ${agent.displayName}`);
    return true;
  }

  getAllAgents() { return Array.from(this.agents.values()); }
  getAgent(agentId) { return this.agents.get(agentId) || null; }
  getAgentCount() { return this.agents.size; }
  dismissAgent(agentId) { return this.removeAgent(agentId); }

  cleanupIdleAgents() {
    const now = Date.now();
    const toRemove = [];
    for (const [id, agent] of this.agents.entries()) {
      if (now - agent.lastActivity > this.config.idleTimeout) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const a = this.agents.get(id);
      console.log(`[AgentManager] Auto-dismiss: ${a.displayName}`);
      this.removeAgent(id);
    }
    if (toRemove.length > 0) this.emit('agents-cleaned', { count: toRemove.length });
  }

  getAgentsByActivity() {
    return this.getAllAgents().sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * 표시 이름 결정
   * 1. slug (예: "toasty-sparking-lecun" → "Toasty Sparking Lecun")
   * 2. projectPath의 basename (예: "pixel-agent-desk-master")
   * 3. 폴백: "Agent"
   */
  formatDisplayName(slug, projectPath) {
    if (slug) {
      return formatSlugToDisplayName(slug);
    }
    if (projectPath) {
      return path.basename(projectPath);
    }
    return 'Agent';
  }

  getStats() {
    const agents = this.getAllAgents();
    const counts = { Done: 0, Thinking: 0, Working: 0, Waiting: 0, Help: 0 };
    for (const agent of agents) {
      if (counts.hasOwnProperty(agent.state)) {
        counts[agent.state]++;
      }
    }
    return {
      total: agents.length,
      byState: counts
    };
  }
}

module.exports = AgentManager;
