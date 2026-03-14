/**
 * Office Pipeline — Room detection, desk partitioning, stage progression
 * Maps agent activity to specific office rooms based on pipeline patterns.
 */

/* eslint-disable no-unused-vars */

// ─── Pipeline → Room mapping ───
// Patterns matched against agent metadata (currentTool, lastMessage, project context)
var PIPELINE_ROOMS = {
  content: [
    /ca-pipeline/, /daily-pipeline/, /run-rss-scrape/, /daily-digest/,
    /backfill-day/, /backfill-range/, /retrospective/,
    /forge\//, /generate-mcqs/, /generate-concept/, /mcq-cascade/,
    /content-forge/, /concept-gen/, /gather-topic-context/,
    /generate-explanations/, /enrich-digest/, /digest-mcq/,
    /scrape-drishti/, /scrape-ioi/, /rewrite-articles/,
    /generate-ssc/, /generate-polity/, /generate-jaiib/,
    /process-books/, /extract-lax/, /chunk-/,
    /seed-upsc/, /seed-ssc/, /seed-banking/, /seed-nda/, /seed-tnpsc/,
    /telegram-scrap/, /community-scrap/, /scrape-reddit/,
    /generate-mcq-card/, /generate-mcq-carousel/, /generate-digest-carousel/,
  ],
  qa: [
    /audit-promote/, /audit-staging/, /pre-screen/,
    /blind-solve/, /verify-mismatch/, /collect-verdicts/,
    /execute-promotions/, /promote-storm/, /content-health/,
    /validate/, /batch-validate/, /flag-corrupted/,
    /correct-book/, /unflag-/, /check-q-schema/,
    /qa\//, /review-queue/,
  ],
};
// No match → 'command' (default for general dev / lead agents)

// ─── Stage progression within Content Factory (left→right) ───
var STAGE_PATTERNS = [
  // Stage 0: Scrape/Fetch (leftmost desks)
  [/scrape/, /rss/, /ioi/, /drishti/, /backfill/, /extract/, /telegram-scrap/, /community-scrap/],
  // Stage 1: Process/Group
  [/digest/, /rewrite/, /enrich/, /process-books/, /chunk-/, /seed-/],
  // Stage 2: Generate
  [/generate-/, /mcq-cascade/, /forge/, /concept-gen/, /gather-topic/],
  // Stage 3: Ship/Promote
  [/promote/, /publish/, /insert/, /carousel/, /mcq-card/],
];

// ─── Room spatial bounds (calibrated from actual office_xy.webp coordinates) ───
// Map: 864x800. Desks 0-7 bottom-left (blue), Meeting 8-15 bottom-right (yellow).
// War Room (mid-right) has boards → pipeline agents sit near them (Conference front row).
// Dev Lab (bottom-left) = general coding agents (default).
var ROOM_BOUNDS = {
  command: { minX: 0, maxX: 450, minY: 480, maxY: 999 },     // Dev Lab (bottom-left) → general dev agents
  content: { minX: 450, maxX: 999, minY: 440, maxY: 520 },    // Conference front row (near boards) → content/CA pipelines
  qa:      { minX: 450, maxX: 999, minY: 520, maxY: 999 },    // Conference back row → QA Gate
};

// ─── Room desk partitions (populated by partitionDesksByRoom) ───
var roomDesks = {
  content: [],  // desk indices for Content Factory
  qa: [],       // desk indices for QA Gate
  command: [],  // desk indices for Command Center
};

/**
 * Partition the flat desk array into room groups based on spatial bounds.
 * Call after parseMapCoordinates().
 */
function partitionDesksByRoom(deskCoords) {
  roomDesks.content = [];
  roomDesks.qa = [];
  roomDesks.command = [];

  for (var i = 0; i < deskCoords.length; i++) {
    var d = deskCoords[i];
    var assigned = false;
    for (var room in ROOM_BOUNDS) {
      var b = ROOM_BOUNDS[room];
      if (d.x >= b.minX && d.x <= b.maxX && d.y >= b.minY && d.y <= b.maxY) {
        roomDesks[room].push(i);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // Desks outside all bounds go to command (catch-all)
      roomDesks.command.push(i);
    }
  }

  console.log('[Pipeline] Room partitions — content:', roomDesks.content.length,
    'qa:', roomDesks.qa.length, 'command:', roomDesks.command.length);
}

/**
 * Detect which room an agent should be in based on their activity.
 * Checks currentTool and lastMessage against PIPELINE_ROOMS patterns.
 * @returns {string} 'content' | 'qa' | 'command'
 */
function detectPipelineRoom(agent) {
  var text = _getAgentActivityText(agent);
  if (!text) return 'command';

  for (var room in PIPELINE_ROOMS) {
    var patterns = PIPELINE_ROOMS[room];
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) return room;
    }
  }
  return 'command';
}

/**
 * Detect pipeline stage within Content Factory (0-3).
 * Only meaningful when room === 'content'.
 * @returns {number} 0-3 (scrape, process, generate, ship) or -1 if unknown
 */
function detectStage(agent) {
  var text = _getAgentActivityText(agent);
  if (!text) return -1;

  for (var s = 0; s < STAGE_PATTERNS.length; s++) {
    var patterns = STAGE_PATTERNS[s];
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) return s;
    }
  }
  return -1;
}

/**
 * Get desks for a specific room, optionally filtered by stage.
 * For content room with a known stage, returns only desks in that stage's column.
 * @returns {number[]} array of desk indices
 */
function getDesksForRoom(room, stage) {
  var desks = roomDesks[room] || roomDesks.command;
  if (desks.length === 0) desks = roomDesks.command;

  // Stage-based sub-selection within content room
  if (room === 'content' && stage >= 0 && stage < 4) {
    var perStage = Math.max(1, Math.floor(desks.length / 4));
    var start = stage * perStage;
    var end = (stage === 3) ? desks.length : start + perStage;
    var stageDesks = desks.slice(start, end);
    if (stageDesks.length > 0) return stageDesks;
  }

  return desks;
}

/**
 * Get room display name for UI.
 */
function getRoomDisplayName(room) {
  var names = {
    content: 'Content Factory',
    qa: 'QA Gate',
    command: 'Command Center',
  };
  return names[room] || 'Office';
}

/**
 * Get stage display name for UI.
 */
function getStageDisplayName(stage) {
  var names = ['Scrape/Fetch', 'Process/Group', 'Generate', 'Ship/Promote'];
  return (stage >= 0 && stage < names.length) ? names[stage] : null;
}

// ─── Internal ───

function _getAgentActivityText(agent) {
  if (!agent) return '';
  var parts = [];
  if (agent.metadata) {
    if (agent.metadata.tool) parts.push(agent.metadata.tool);
    if (agent.metadata.lastMessage) parts.push(agent.metadata.lastMessage);
    if (agent.metadata.status) parts.push(agent.metadata.status);
  }
  if (agent.role) parts.push(agent.role);
  if (agent.bubble && agent.bubble.text) parts.push(agent.bubble.text);
  return parts.join(' ').toLowerCase();
}
