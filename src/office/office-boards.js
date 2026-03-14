/**
 * Office Boards — Whiteboard (active tasks) + TV Screen (recent completions)
 * Renders text overlays on the War Room boards using canvas fillText.
 */

/* eslint-disable no-unused-vars */

// ─── Board positions (calibrated from office_bg_32.webp) ───
// War Room is mid-right. Whiteboard is the white rectangle, TV is the dark screen.
var BOARD_CONFIG = {
  // TV screen — dark rectangle in the War Room (calibrated via Playwright)
  whiteboard: {
    x: 690,
    y: 330,
    w: 90,
    h: 40,
    title: 'ACTIVE',
    titleColor: '#4ade80',
    textColor: '#ffffff',
  },
};

// ─── Recent completions tracker ───
var recentCompletions = [];
var MAX_COMPLETIONS = 4;

/**
 * Track when an agent completes work (transitions to done/idle).
 * Called from office-character.js on state change.
 */
function trackCompletion(agentName, taskDescription) {
  var now = new Date();
  var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  recentCompletions.unshift({
    time: timeStr,
    agent: agentName,
    task: taskDescription || 'task',
    timestamp: Date.now(),
  });
  // Keep only recent entries
  if (recentCompletions.length > MAX_COMPLETIONS) {
    recentCompletions.length = MAX_COMPLETIONS;
  }
}

// ─── Pipeline status cache (populated via SSE from /api/pipeline-status) ───
var pipelineStatusCache = {};

/** Fetch pipeline statuses and listen for SSE updates */
function initPipelineStatusListener() {
  // Initial fetch
  fetch('/api/pipeline-status').then(function (r) { return r.json(); }).then(function (data) {
    pipelineStatusCache = data || {};
  }).catch(function () {});
}

/** Called from dashboard SSE handler for pipeline.status events */
function onPipelineStatusUpdate(data) {
  if (data && data.key) {
    pipelineStatusCache[data.key] = { status: data.status, detail: data.detail, timestamp: data.timestamp };
  }
}

/**
 * Get active tasks from characters currently working.
 * Enriched with pipeline status if available.
 */
function getActiveTasks() {
  if (typeof officeCharacters === 'undefined') return [];
  var chars = officeCharacters.getCharacterArray();
  var tasks = [];
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (c.agentState === 'working' || c.agentState === 'thinking') {
      // Check for rich pipeline status first
      var pipeStatus = pipelineStatusCache[c.id];
      var now = Date.now();
      var statusText = '';
      if (pipeStatus && (now - pipeStatus.timestamp) < 300000) {
        statusText = pipeStatus.status;
      } else {
        // Fallback: shorten tool name
        var tool = (c.metadata && c.metadata.tool) || '';
        statusText = tool;
        if (statusText.length > 15) {
          statusText = statusText.replace(/^mcp__plugin_playwright_playwright__/, 'pw:');
          statusText = statusText.replace(/^mcp__plugin_supabase_supabase__/, 'sb:');
        }
        if (statusText.length > 15) statusText = statusText.slice(0, 14) + '…';
      }
      tasks.push({
        name: (c.role || 'Agent').slice(0, 12),
        tool: statusText || c.agentState,
        state: c.agentState,
      });
    }
  }
  return tasks;
}

/**
 * Draw both boards on the canvas. Called from officeRenderer.render().
 */
function drawBoards(ctx) {
  drawWhiteboard(ctx);
  // TV area is too small (26x8px) for readable text — skip
}

function drawWhiteboard(ctx) {
  var board = BOARD_CONFIG.whiteboard;
  var tasks = getActiveTasks();
  var now = Date.now();
  var completions = recentCompletions.filter(function (c) { return now - c.timestamp < 600000; });

  ctx.save();
  var leftX = board.x - board.w / 2 + 3;
  var rightX = board.x + board.w / 2 - 3;

  // Active tasks (left side)
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = board.titleColor;
  ctx.fillText('ACTIVE', leftX, board.y + 8);

  ctx.font = '6px monospace';
  if (tasks.length === 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillText('idle', leftX, board.y + 18);
  } else {
    for (var i = 0; i < Math.min(tasks.length, 3); i++) {
      var t = tasks[i];
      var y = board.y + 17 + i * 8;
      // Colored dot
      ctx.fillStyle = t.state === 'working' ? '#fb923c' : '#a78bfa';
      ctx.beginPath();
      ctx.arc(leftX + 2, y - 2, 1.5, 0, Math.PI * 2);
      ctx.fill();
      // Name in white
      ctx.fillStyle = '#ffffff';
      ctx.fillText(t.name.slice(0, 10), leftX + 6, y);
    }
  }

  // Recent completions (right side)
  ctx.textAlign = 'right';
  ctx.font = 'bold 7px monospace';
  ctx.fillStyle = '#4ade80';
  ctx.fillText('DONE', rightX, board.y + 8);

  ctx.font = '6px monospace';
  if (completions.length === 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fillText('—', rightX, board.y + 18);
  } else {
    for (var j = 0; j < Math.min(completions.length, 3); j++) {
      var c = completions[j];
      var cy = board.y + 17 + j * 8;
      var alpha = Math.max(0.4, 1 - (now - c.timestamp) / 600000);
      ctx.fillStyle = 'rgba(74, 222, 128, ' + alpha + ')';
      ctx.fillText('✓' + c.agent.slice(0, 8), rightX, cy);
    }
  }

  ctx.restore();
}

function drawTVScreen(ctx) {
  var board = BOARD_CONFIG.tv;

  ctx.save();

  // Completion entry (just the most recent one — TV is small)
  ctx.font = 'bold 6px monospace';
  ctx.textAlign = 'center';

  var now = Date.now();
  var visible = recentCompletions.filter(function (c) {
    return now - c.timestamp < 600000;
  });

  if (visible.length === 0) {
    ctx.fillStyle = 'rgba(100, 116, 139, 0.4)';
    ctx.fillText('—', board.x, board.y + 10);
  } else {
    var c = visible[0];
    var alpha = Math.max(0.4, 1 - (now - c.timestamp) / 600000);
    ctx.fillStyle = 'rgba(134, 239, 172, ' + alpha + ')';
    ctx.fillText('✓ ' + c.agent.slice(0, 8), board.x, board.y + 10);
  }

  ctx.restore();
}
