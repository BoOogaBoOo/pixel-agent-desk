/**
 * Dashboard Data Adapter
 * Converts Pixel Agent Desk agent format to Dashboard format
 */

const path = require('path');

/**
 * State mapping from Pixel Agent Desk to Dashboard
 */
const STATE_MAP = {
  'Working': 'working',
  'Thinking': 'thinking',
  'Done': 'completed',
  'Waiting': 'waiting',
  'Help': 'help',
  'Error': 'error'
};

/**
 * Default state for unmapped values
 */
const DEFAULT_STATE = 'idle';

/**
 * Map Pixel Agent Desk state to Dashboard state
 * @param {string} pixelState - Pixel Agent Desk state
 * @returns {string} Dashboard state
 */
function mapPixelStateToDashboardState(pixelState) {
  return STATE_MAP[pixelState] || DEFAULT_STATE;
}

/**
 * Extract project name from full path
 * @param {string} projectPath - Full project path
 * @returns {string} Project name or 'Default'
 */
function extractProjectName(projectPath) {
  if (!projectPath) return 'Default';
  return path.basename(projectPath);
}

/**
 * Determine agent type based on properties
 * @param {Object} agent - Pixel Agent Desk agent object
 * @returns {string} Agent type: 'main', 'subagent', or 'teammate'
 */
function determineAgentType(agent) {
  if (agent.isSubagent) return 'subagent';
  if (agent.isTeammate) return 'teammate';
  return 'main';
}

/**
 * Calculate elapsed time for an agent
 * @param {Object} agent - Pixel Agent Desk agent object
 * @returns {number} Elapsed time in milliseconds
 */
function calculateElapsedTime(agent) {
  if (!agent.firstSeen) return 0;
  return Date.now() - agent.firstSeen;
}

/**
 * Check if agent is currently active
 * @param {string} state - Agent state
 * @returns {boolean} True if agent is working or thinking
 */
function isAgentActive(state) {
  return state === 'Working' || state === 'Thinking';
}

/**
 * Adapt a single Pixel Agent Desk agent to Dashboard format
 * @param {Object} pixelAgent - Pixel Agent Desk agent object
 * @returns {Object} Dashboard formatted agent
 */
function adaptAgentToDashboard(pixelAgent) {
  return {
    id: pixelAgent.id || pixelAgent.sessionId,
    sessionId: pixelAgent.sessionId,
    name: pixelAgent.displayName || 'Agent',
    project: extractProjectName(pixelAgent.projectPath),
    status: mapPixelStateToDashboardState(pixelAgent.state),
    type: determineAgentType(pixelAgent),
    metadata: {
      isSubagent: pixelAgent.isSubagent || false,
      isTeammate: pixelAgent.isTeammate || false,
      projectPath: pixelAgent.projectPath || '',
      parentId: pixelAgent.parentId || null,
      source: 'pixel-agent-desk'
    },
    timing: {
      elapsed: calculateElapsedTime(pixelAgent),
      active: isAgentActive(pixelAgent.state)
    }
  };
}

/**
 * Adapt multiple Pixel Agent Desk agents to Dashboard format
 * @param {Array<Object>} pixelAgents - Array of Pixel Agent Desk agent objects
 * @returns {Array<Object>} Array of Dashboard formatted agents
 */
function adaptAgentsToDashboard(pixelAgents) {
  if (!Array.isArray(pixelAgents)) return [];
  return pixelAgents.map(adaptAgentToDashboard);
}

/**
 * Validate agent data before sending to Dashboard
 * @param {Object} agent - Agent object to validate
 * @returns {boolean} True if agent data is valid
 */
function validateAgentData(agent) {
  if (!agent) return false;
  if (!agent.id && !agent.sessionId) return false;
  return true;
}

/**
 * Sanitize agent data to remove potentially sensitive information
 * @param {Object} agent - Agent object to sanitize
 * @returns {Object} Sanitized agent object
 */
function sanitizeAgentData(agent) {
  const sanitized = { ...agent };

  // Remove sensitive fields if they exist
  delete sanitized.jsonlPath;
  delete sanitized.pid;

  // Ensure metadata exists
  if (!sanitized.metadata) {
    sanitized.metadata = {};
  }

  return sanitized;
}

module.exports = {
  adaptAgentToDashboard,
  adaptAgentsToDashboard,
  mapPixelStateToDashboardState,
  extractProjectName,
  determineAgentType,
  calculateElapsedTime,
  isAgentActive,
  validateAgentData,
  sanitizeAgentData,
  STATE_MAP,
  DEFAULT_STATE
};
