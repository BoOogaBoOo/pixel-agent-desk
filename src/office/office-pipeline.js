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

// ─── CA Pipeline Phase System (7 phases + done seat) ───
// Maps .ca/ orchestrator phases to specific seats in the conference room.
// Phase detection via prompt filenames, task.yaml state, or tool activity.
var CA_PHASE_DEFS = [
  { phase: 1, label: 'P1 Ingest',     short: '1', patterns: [/phase-1/, /ingest/, /scrape-all/, /fetch-content/] },
  { phase: 2, label: 'P2 Editorial',   short: '2', patterns: [/phase-2/, /editorial/, /daily-digest/, /write.*digest/] },
  { phase: 3, label: 'P3a Generate',   short: '3', patterns: [/phase-3a/, /generate.*mcq/, /mcq-cascade/, /digest-mcq/] },
  { phase: 4, label: 'P3b Audit',      short: '4', patterns: [/phase-3b/, /audit/, /blind-solve/, /pre-screen/] },
  { phase: 5, label: 'P4 Enrich',      short: '5', patterns: [/phase-4/, /enrich/, /lkg/, /concept.*link/] },
  { phase: 6, label: 'P5 Connect',     short: '6', patterns: [/phase-5/, /connect/] },
  { phase: 7, label: 'P6 Publish',     short: '7', patterns: [/phase-6/, /publish/, /verify.*publish/, /final.*check/] },
  { phase: 8, label: 'P7 Media',       short: '8', patterns: [/phase-7/, /media/, /tts/, /carousel/, /reel/, /generate-ca-reel/, /generate-ca-carousel/] },
  { phase: 9, label: 'P8 Distribute',  short: '9', patterns: [/phase-8/, /distribut/, /reddit.*post/, /telegram.*post/, /upload.*youtube/, /facebook.*post/] },
];
// No dedicated done seat — agent goes to lounge with confetti
var CA_DONE_PHASE = 10; // caPhase=10 means all 9 phases complete

// Desk indices assigned to CA phases (populated by assignCAPhaseDeskIndices after partitioning)
// Index 0-6 = phases 1-7, index 7 = done seat
var caPhaseDeskIndices = []; // length 8

// Phase labels for rendering on desks (deskIndex → label string)
var caDeskLabels = {}; // e.g. { 8: 'INGEST', 9: 'EDITORIAL', ... }

/**
 * Assign 8 conference-room desks to CA pipeline phases.
 * Call after partitionDesksByRoom(). Uses pipeline+qa desks (both tables).
 * Returns true if 8 seats were found.
 */
function assignCAPhaseDeskIndices() {
  // Gather all desks in the conference area (pipeline + qa traits = 2 tables)
  var conferenceDesks = [];
  for (var idx in deskTraits) {
    var i = parseInt(idx);
    var traits = deskTraits[i];
    if (traits.indexOf('pipeline') !== -1 || traits.indexOf('qa') !== -1) {
      conferenceDesks.push(i);
    }
  }
  // Sort by desk index for deterministic left→right, top→bottom ordering
  conferenceDesks.sort(function (a, b) { return a - b; });

  // Need 9 desks for 9 phases (no done seat — agent goes to lounge)
  var needed = CA_PHASE_DEFS.length; // 9
  if (conferenceDesks.length < needed) {
    // Borrow nearest dev desks to fill the gap
    var devDesks = [];
    for (var di in deskTraits) {
      if (deskTraits[di].indexOf('dev') !== -1) devDesks.push(parseInt(di));
    }
    // Sort dev desks by proximity to conference area (highest index = closest)
    devDesks.sort(function (a, b) { return b - a; });
    var extra = devDesks.slice(0, needed - conferenceDesks.length);
    conferenceDesks = conferenceDesks.concat(extra);
    console.log('[Pipeline] Borrowed', extra.length, 'dev desk(s) for CA phases:', extra);
  }
  caPhaseDeskIndices = conferenceDesks.slice(0, needed);

  // Build label map
  caDeskLabels = {};
  for (var p = 0; p < CA_PHASE_DEFS.length && p < caPhaseDeskIndices.length; p++) {
    caDeskLabels[caPhaseDeskIndices[p]] = CA_PHASE_DEFS[p].short;
  }

  console.log('[Pipeline] CA phase desks assigned:', caPhaseDeskIndices, 'labels:', caDeskLabels);
  return caPhaseDeskIndices.length >= 8;
}

/**
 * Detect which CA pipeline phase an agent is in (1-7), or 0 if not in CA pipeline.
 * Checks agent activity text + agent name against CA_PHASE_DEFS patterns.
 */
function detectCAPhase(agent) {
  var text = _getAgentActivityText(agent);

  // Also include agent name/role in detection text (CApipe, ca-pipe, etc.)
  var agentName = (agent.role || '').toLowerCase();
  if (agent.metadata && agent.metadata.name) agentName += ' ' + agent.metadata.name.toLowerCase();
  var fullText = (text + ' ' + agentName).toLowerCase();

  // Check if this is a CA pipeline agent — MUST be named CApipe/ca-pipe/ca_pipe
  // Activity-only signals (ca-pipeline, phase-1) are NOT enough — prevents false positives
  var isCANamedAgent = /capipe|ca-pipe|ca_pipe/.test(agentName);
  if (!isCANamedAgent) return 0;

  // Try to match specific phase from activity text
  for (var p = 0; p < CA_PHASE_DEFS.length; p++) {
    var patterns = CA_PHASE_DEFS[p].patterns;
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(fullText)) return CA_PHASE_DEFS[p].phase;
    }
  }

  // CA agent detected but no specific phase matched — check pipeline status cache
  if (typeof pipelineStatusCache !== 'undefined') {
    var pStatus = pipelineStatusCache[agent.id];
    if (pStatus && pStatus.detail) {
      var phaseMatch = pStatus.detail.match(/phase[- ]?(\d)/i);
      if (phaseMatch) {
        var phaseNum = parseInt(phaseMatch[1]);
        if (phaseNum >= 1 && phaseNum <= 7) return phaseNum;
      }
    }
  }

  // Default: if agent is named CApipe, use pipeline status or keep highest phase
  if (/capipe|ca-pipe|ca_pipe/.test(agentName)) {
    // Check pipeline status cache for explicit phase (set via POST /api/pipeline-status)
    if (typeof pipelineStatusCache !== 'undefined') {
      // Check by agent ID and global
      var keys = [agent.id, '_global'];
      for (var k = 0; k < keys.length; k++) {
        var ps = pipelineStatusCache[keys[k]];
        if (ps && ps.detail) {
          var pm = ps.detail.match(/phase[- ]?(\d)/i);
          if (pm) {
            var pn = parseInt(pm[1]);
            if (pn >= 1 && pn <= 7) return Math.max(pn, agent.caPhase || 0);
          }
        }
        if (ps && ps.status) {
          var sm = ps.status.match(/phase[- ]?(\d)/i);
          if (sm) {
            var sn = parseInt(sm[1]);
            if (sn >= 1 && sn <= 7) return Math.max(sn, agent.caPhase || 0);
          }
        }
      }
    }
    // Never regress — keep highest phase seen (including done)
    if (agent.caPhase && agent.caPhase > 0) return agent.caPhase;
    return 1; // default to ingest
  }

  return 0;
}

/**
 * Get the desk index for a CA pipeline phase (1-7) or done seat (8).
 * Returns -1 if not enough desks or phase out of range.
 */
function getCAPhaseDesk(phase) {
  if (phase < 1 || phase > 8) return -1;
  var idx = phase - 1; // 0-based
  return (idx < caPhaseDeskIndices.length) ? caPhaseDeskIndices[idx] : -1;
}

/**
 * Get the CA done seat desk index.
 * Returns -1 — no dedicated done seat (agent goes to lounge with confetti).
 */
function getCADoneSeatDesk() {
  return -1;
}

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

  // Assign CA phase desks after trait partitioning
  if (typeof assignCAPhaseDeskIndices === 'function') {
    assignCAPhaseDeskIndices();
  }
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

/**
 * Get CA phase display name for UI.
 * @param {number} phase - 1-7
 */
function getCAPhaseDisplayName(phase) {
  if (phase < 1 || phase > CA_PHASE_DEFS.length) return null;
  return CA_PHASE_DEFS[phase - 1].label;
}

/**
 * Get desk label for a given desk index (for rendering on laptops).
 * Returns null if no label assigned.
 */
function getDeskLabel(deskIndex) {
  return caDeskLabels[deskIndex] || null;
}

/**
 * Manually set a CA agent's phase (called from dashboard or hook events).
 * Updates the character's caPhase, reassigns desk, and refreshes tracker.
 * @param {string} agentName - e.g. 'CApipe'
 * @param {number} phase - 1-7 or 8 for done
 */
function setCAPhase(agentName, phase) {
  if (typeof officeCharacters === 'undefined') return;
  var chars = officeCharacters.getCharacterArray();
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (c.role === agentName || (c.metadata && c.metadata.name === agentName)) {
      c.caPhase = phase;
      if (phase >= 1 && phase <= CA_PHASE_DEFS.length) {
        officeCharacters.assignDesk(c.id);
      } else if (phase >= CA_DONE_PHASE) {
        // Done — release desk, agent walks to lounge with confetti
        officeCharacters.releaseDesk(c.id);
        if (typeof officeRenderer !== 'undefined') {
          officeRenderer.spawnEffect('confetti', c.x, c.y - 45);
        }
      }
      if (typeof updateCAPipelineTracker === 'function') updateCAPipelineTracker();
      // Persist to server so page reloads keep the state (use the actual caPhase which may be higher)
      _persistCAPhase(c.caPhase);
      break;
    }
  }
}

/** Persist CA phase to dashboard server (survives page reloads) */
function _persistCAPhase(phase) {
  try {
    fetch('/api/pipeline-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'phase-' + phase, detail: 'phase-' + phase, agentId: '_ca_pipeline' }),
    });
  } catch (e) { /* best effort */ }
}

/** Restore CA phase from server on page load. Call after agents are loaded. */
function restoreCAPhaseFromServer() {
  fetch('/api/pipeline-status').then(function (r) { return r.json(); }).then(function (data) {
    var entry = data['_ca_pipeline'] || data._ca_pipeline;
    if (!entry) return;
    var m = (entry.status || '').match(/phase-(\d+)/);
    if (!m) return;
    var phase = parseInt(m[1]);
    if (phase < 1) return;
    // Find CApipe agent and restore phase
    if (typeof officeCharacters === 'undefined') return;
    var chars = officeCharacters.getCharacterArray();
    for (var i = 0; i < chars.length; i++) {
      if (/capipe|ca-pipe|ca_pipe/i.test(chars[i].role || '')) {
        chars[i].caPhase = phase;
        // Only assign desk for active phases, not done
        if (phase >= 1 && phase < CA_DONE_PHASE) {
          officeCharacters.assignDesk(chars[i].id);
        }
        if (typeof updateCAPipelineTracker === 'function') updateCAPipelineTracker();
        break;
      }
    }
  }).catch(function () { /* best effort */ });
}

// ─── CA Pipeline Sidebar Tracker ───

/**
 * Update the CA pipeline tracker in the sidebar.
 * Scans all characters for CA pipeline agents and renders phase checkboxes.
 * Called on every agent update.
 */
function updateCAPipelineTracker() {
  var dateEl = document.getElementById('caTrackerDate');
  var phasesEl = document.getElementById('caTrackerPhases');
  if (!dateEl || !phasesEl) return;

  // Find any CA pipeline agent
  if (typeof officeCharacters === 'undefined') return;
  var chars = officeCharacters.getCharacterArray();
  var caAgent = null;
  for (var i = 0; i < chars.length; i++) {
    if (chars[i].caPhase > 0) { caAgent = chars[i]; break; }
  }

  // Check persisted pipeline status (survives page reloads)
  var persistedPhase = 0;
  if (typeof pipelineStatusCache !== 'undefined' && pipelineStatusCache._ca_pipeline) {
    var ps = pipelineStatusCache._ca_pipeline;
    var pm = (ps.status || '').match(/phase-(\d+)/);
    if (pm) persistedPhase = parseInt(pm[1]);
  }

  if (!caAgent) {
    // No active CA agent — check if there's a completed run persisted
    if (persistedPhase >= CA_DONE_PHASE) {
      dateEl.textContent = new Date().toISOString().slice(0, 10) + ' \u2713';
      dateEl.className = 'ca-tracker-date done';
      while (phasesEl.firstChild) phasesEl.removeChild(phasesEl.firstChild);
      return;
    }
    // Show active phases from persisted state even without agent
    if (persistedPhase >= 1) {
      dateEl.textContent = new Date().toISOString().slice(0, 10);
      dateEl.className = 'ca-tracker-date active';
      // Fall through to render phases using persistedPhase
    } else {
      dateEl.textContent = 'No active run';
      dateEl.className = 'ca-tracker-date';
      while (phasesEl.firstChild) phasesEl.removeChild(phasesEl.firstChild);
      return;
    }
  }

  // Show date
  var today = new Date();
  var dateStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
  dateEl.textContent = dateStr;
  dateEl.className = 'ca-tracker-date active';

  // Use the HIGHER of character phase and persisted phase (never regress)
  var currentPhase = caAgent ? Math.max(caAgent.caPhase || 0, persistedPhase) : persistedPhase;
  var agentState = caAgent ? caAgent.agentState : 'idle';

  // Build phase rows using DOM methods (no innerHTML)
  while (phasesEl.firstChild) phasesEl.removeChild(phasesEl.firstChild);

  var isDone = (currentPhase >= CA_DONE_PHASE);

  // Collapse when complete — just show date + checkmark
  if (isDone) {
    dateEl.textContent = dateStr + ' \u2713';
    dateEl.className = 'ca-tracker-date done';
    while (phasesEl.firstChild) phasesEl.removeChild(phasesEl.firstChild);
    return;
  }

  var allPhases = CA_PHASE_DEFS.concat([{ phase: CA_DONE_PHASE, label: 'Done' }]);
  for (var p = 0; p < allPhases.length; p++) {
    var phaseNum = allPhases[p].phase;
    var label = allPhases[p].label;

    var row = document.createElement('div');
    row.className = 'ca-phase-row';

    var check = document.createElement('div');
    check.className = 'ca-phase-check';

    var labelSpan = document.createElement('span');
    labelSpan.className = 'ca-phase-label';
    labelSpan.textContent = label;

    if (isDone) {
      // All done — every phase checked
      row.className += ' done';
      check.textContent = '\u2713';
    } else if (phaseNum < currentPhase) {
      row.className += ' done';
      check.textContent = '\u2713';
    } else if (phaseNum === currentPhase) {
      if (agentState === 'error' || agentState === 'help') {
        row.className += ' error';
        check.textContent = '\u2715';
      } else {
        row.className += ' active';
        check.textContent = '\u25B8';
      }
    }
    // Future phases stay dim (default class)

    row.appendChild(check);
    row.appendChild(labelSpan);
    phasesEl.appendChild(row);
  }
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
