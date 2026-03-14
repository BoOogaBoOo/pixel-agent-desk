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

// ─── Trait-based desk system ───
// Each desk gets traits based on spatial position. Agents request desks by trait.
// Traits: 'dev' (general work), 'pipeline' (content/CA), 'qa' (audit/verify)
var DESK_TRAITS = {
  // Spatial bounds → trait assignment (calibrated from office_xy.webp coordinates)
  regions: [
    { trait: 'dev',      minX: 0,   maxX: 450, minY: 480, maxY: 999 },  // Dev Lab (bottom-left, blue desks)
    { trait: 'pipeline', minX: 450, maxX: 999, minY: 440, maxY: 520 },  // Conference front (near boards)
    { trait: 'qa',       minX: 450, maxX: 999, minY: 520, maxY: 999 },  // Conference back row
  ],
};

// Desk index → traits array (populated by partitionDesksByRoom)
var deskTraits = {};  // e.g. { 0: ['dev'], 8: ['pipeline'], 12: ['qa'] }

// ─── Idle zone partitioning ───
// Idle spots partitioned by room for mood/state-based routing
var IDLE_ZONES = {
  cafe:    { minX: 0,   maxX: 450, minY: 0,   maxY: 170 },  // Top-left patio/cafe
  lounge:  { minX: 450, maxX: 999, minY: 0,   maxY: 350 },  // Top-right living room
  library: { minX: 250, maxX: 450, minY: 300,  maxY: 450 },  // Mid-center bookshelves
  server:  { minX: 0,   maxX: 250, minY: 300,  maxY: 500 },  // Mid-left server room (no idle spots by default)
};

var idleByZone = { cafe: [], lounge: [], library: [], server: [] };

/** Partition idle spots into zones. Call after parseMapCoordinates(). */
function partitionIdleByZone(idleCoords) {
  idleByZone = { cafe: [], lounge: [], library: [], server: [] };
  for (var i = 0; i < idleCoords.length; i++) {
    var s = idleCoords[i];
    var assigned = false;
    for (var zone in IDLE_ZONES) {
      var b = IDLE_ZONES[zone];
      if (s.x >= b.minX && s.x <= b.maxX && s.y >= b.minY && s.y <= b.maxY) {
        idleByZone[zone].push(s);
        assigned = true;
        break;
      }
    }
    if (!assigned) idleByZone.library.push(s); // default
  }
  console.log('[Pipeline] Idle zones — cafe:', idleByZone.cafe.length,
    'lounge:', idleByZone.lounge.length, 'library:', idleByZone.library.length,
    'server:', idleByZone.server.length);
}

/**
 * Pick the right idle zone for an agent based on state.
 * @param {object} agent - office character
 * @returns {string} zone name: 'cafe', 'lounge', 'library', 'server'
 */
function pickIdleZone(agent) {
  // Error/Help → server room (diagnostics)
  if (agent.agentState === 'error' || agent.agentState === 'help') return 'server';
  // Background work → cafe (resting while work runs)
  if (agent.metadata && agent.metadata.hasBackgroundWork) return 'cafe';
  // Recently finished (<2 min) → library (standby)
  var idleMs = Date.now() - (agent.lastActivityTime || Date.now());
  if (idleMs < 120000) return 'library';
  // Long idle → lounge (break)
  return 'lounge';
}

// Room→trait mapping for detectPipelineRoom results
var ROOM_TO_TRAIT = {
  content: 'pipeline',
  qa: 'qa',
  command: 'dev',
};

// ─── Room desk partitions (populated by partitionDesksByRoom, backwards-compat) ───
var roomDesks = {
  content: [],
  qa: [],
  command: [],
};

/**
 * Partition desks by spatial regions → assign traits. Also populate roomDesks for backwards compat.
 * Call after parseMapCoordinates().
 */
function partitionDesksByRoom(deskCoords) {
  roomDesks.content = [];
  roomDesks.qa = [];
  roomDesks.command = [];
  deskTraits = {};

  for (var i = 0; i < deskCoords.length; i++) {
    var d = deskCoords[i];
    var traits = [];
    for (var r = 0; r < DESK_TRAITS.regions.length; r++) {
      var region = DESK_TRAITS.regions[r];
      if (d.x >= region.minX && d.x <= region.maxX && d.y >= region.minY && d.y <= region.maxY) {
        traits.push(region.trait);
      }
    }
    if (traits.length === 0) traits.push('dev'); // default trait
    deskTraits[i] = traits;

    // Backwards compat: populate roomDesks
    if (traits.indexOf('pipeline') !== -1) roomDesks.content.push(i);
    else if (traits.indexOf('qa') !== -1) roomDesks.qa.push(i);
    else roomDesks.command.push(i);
  }

  console.log('[Pipeline] Desk traits assigned — dev:', roomDesks.command.length,
    'pipeline:', roomDesks.content.length, 'qa:', roomDesks.qa.length);
}

/**
 * Find available desks matching a trait.
 * @param {string} trait - 'dev', 'pipeline', or 'qa'
 * @param {Set} usedDesks - set of occupied desk indices
 * @returns {number[]} available desk indices with matching trait
 */
function findDesksByTrait(trait, usedDesks) {
  var results = [];
  for (var idx in deskTraits) {
    var i = parseInt(idx);
    if (deskTraits[i].indexOf(trait) !== -1 && !usedDesks.has(i)) {
      results.push(i);
    }
  }
  return results;
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
 * Uses trait-based lookup with fallback chain: requested trait → 'dev' → all desks.
 * @returns {number[]} array of desk indices
 */
function getDesksForRoom(room, stage) {
  var trait = ROOM_TO_TRAIT[room] || 'dev';
  var desks = [];
  for (var idx in deskTraits) {
    if (deskTraits[idx].indexOf(trait) !== -1) desks.push(parseInt(idx));
  }
  if (desks.length === 0) {
    // Fallback to 'dev' trait
    for (var idx2 in deskTraits) {
      if (deskTraits[idx2].indexOf('dev') !== -1) desks.push(parseInt(idx2));
    }
  }

  // Stage-based sub-selection within pipeline desks
  if (trait === 'pipeline' && stage >= 0 && stage < 4 && desks.length >= 4) {
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
