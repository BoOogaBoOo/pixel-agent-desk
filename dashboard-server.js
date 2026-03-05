/**
 * Dashboard Web Server
 * Enhanced with REST API and WebSocket for real-time updates
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;
const HTML_FILE = path.join(__dirname, 'mission-control.html');

// MIME 타입 매핑
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// Global references to agent manager and WebSocket clients
let agentManager = null;
let missionControlWindow = null;
const wsClients = new Set();

/**
 * Set the agent manager reference
 */
function setAgentManager(manager) {
  agentManager = manager;
}

/**
 * Set the Dashboard window reference
 */
function setDashboardWindow(window) {
  missionControlWindow = window;
}

/**
 * Calculate statistics from agents
 */
function calculateStats() {
  if (!agentManager) {
    return { total: 0, active: 0, completed: 0, byState: {} };
  }

  const agents = agentManager.getAllAgents();
  const stats = {
    total: agents.length,
    active: 0,
    completed: 0,
    working: 0,
    thinking: 0,
    waiting: 0,
    help: 0,
    error: 0,
    done: 0,
    offline: 0,
    byProject: {},
    byType: {
      main: 0,
      subagent: 0,
      teammate: 0
    }
  };

  for (const agent of agents) {
    // State counts
    const state = agent.state.toLowerCase();
    if (stats[state] !== undefined) {
      stats[state]++;
    }

    // Active/Completed counts
    if (agent.state === 'Working' || agent.state === 'Thinking') {
      stats.active++;
      stats.working++;
    } else if (agent.state === 'Done') {
      stats.completed++;
      stats.done++;
    } else if (agent.state === 'Waiting') {
      stats.waiting++;
    } else if (agent.state === 'Help') {
      stats.help++;
      stats.active++;
    } else if (agent.state === 'Error') {
      stats.error++;
    } else if (agent.state === 'Offline') {
      stats.offline++;
    }

    // Project grouping
    const project = agent.projectPath ? path.basename(agent.projectPath) : 'Default';
    if (!stats.byProject[project]) {
      stats.byProject[project] = { total: 0, active: 0, completed: 0 };
    }
    stats.byProject[project].total++;
    if (agent.state === 'Working' || agent.state === 'Thinking' || agent.state === 'Help') {
      stats.byProject[project].active++;
    }
    if (agent.state === 'Done') {
      stats.byProject[project].completed++;
    }

    // Type counts
    if (agent.isSubagent) {
      stats.byType.subagent++;
    } else if (agent.isTeammate) {
      stats.byType.teammate++;
    } else {
      stats.byType.main++;
    }
  }

  return stats;
}

/**
 * Broadcast update to all WebSocket clients
 */
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });

  wsClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (error) {
        console.error('[Dashboard] Error sending to client:', error.message);
      }
    }
  });
}

/**
 * Handle HTTP request
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log(`[Dashboard Server] ${req.method} ${pathname}`);

  // API routes
  if (pathname.startsWith('/api/')) {
    handleAPIRequest(req, res, url);
    return;
  }

  // WebSocket upgrade
  if (pathname === '/ws') {
    // This will be handled by the WebSocket server
    res.writeHead(426); // Upgrade Required
    res.end('WebSocket connection required');
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) {
        console.error('[Dashboard Server] Error reading HTML:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle API requests
 */
function handleAPIRequest(req, res, url) {
  const pathname = url.pathname;

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /api/agents - Get all agents
  if (pathname === '/api/agents' && req.method === 'GET') {
    if (!agentManager) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent manager not available' }));
      return;
    }

    const agents = agentManager.getAllAgents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agents));
    return;
  }

  // GET /api/agents/:id/details - Get agent details
  if (pathname.startsWith('/api/agents/') && req.method === 'GET') {
    if (!agentManager) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent manager not available' }));
      return;
    }

    const agentId = pathname.split('/').pop();
    const agent = agentManager.getAgent(agentId);

    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agent));
    return;
  }

  // GET /api/stats - Get statistics
  if (pathname === '/api/stats' && req.method === 'GET') {
    const stats = calculateStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // GET /api/health - Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: Date.now(),
      agents: agentManager ? agentManager.getAgentCount() : 0
    }));
    return;
  }

  // 404 for unknown API routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'API endpoint not found' }));
}

// Create HTTP server
const server = http.createServer(handleRequest);

// WebSocket server implementation (simple)
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws') {
    // Simple WebSocket handshake
    const key = req.headers['sec-websocket-key'];
    const acceptKey = require('crypto')
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );

    // Create simple WebSocket client wrapper
    const client = {
      socket,
      readyState: 1, // OPEN
      send: (data) => {
        // Simple WebSocket frame encoding
        const frame = [];
        frame.push(0x81); // FIN + Text frame

        const dataBytes = Buffer.from(data);
        const len = dataBytes.length;

        if (len < 126) {
          frame.push(len | 0x80);
        } else if (len < 65536) {
          frame.push(126 | 0x80, (len >> 8) & 0xff, len & 0xff);
        } else {
          frame.push(127 | 0x80,
            (len >> 56) & 0xff, (len >> 48) & 0xff, (len >> 40) & 0xff, (len >> 32) & 0xff,
            (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
        }

        // Mask key (required for server-to-client)
        const maskKey = Buffer.from([0, 0, 0, 0]);
        frame.push(...maskKey);

        socket.write(Buffer.concat([Buffer.from(frame), dataBytes]));
      },
      close: () => {
        socket.end();
      }
    };

    wsClients.add(client);

    // Send initial data
    if (agentManager) {
      const agents = agentManager.getAllAgents();
      client.send(JSON.stringify({
        type: 'initial',
        data: agents,
        timestamp: Date.now()
      }));
    }

    socket.on('close', () => {
      wsClients.delete(client);
      console.log('[Dashboard] WebSocket client disconnected');
    });

    socket.on('error', (err) => {
      console.error('[Dashboard] WebSocket error:', err.message);
      wsClients.delete(client);
    });

    console.log('[Dashboard] WebSocket client connected');
  } else {
    socket.destroy();
  }
});

/**
 * Start the server
 */
function startServer() {
  server.listen(PORT, () => {
    console.log(`[Dashboard Server] 🚀 Server running at http://localhost:${PORT}`);
    console.log(`[Dashboard Server] 📊 Serving mission-control.html`);
    console.log(`[Dashboard Server] 🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });

  // 에러 처리
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dashboard Server] ❌ Port ${PORT} already in use!`);
      console.error('[Dashboard Server] 💡 Another server is already running on this port.');
    } else {
      console.error('[Dashboard Server] ❌ Server error:', err);
    }
  });

  return server;
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Dashboard Server] 🛑 Server shutting down...');

  // Close all WebSocket connections
  wsClients.forEach(client => {
    try {
      client.close();
    } catch (e) {
      // Ignore errors during shutdown
    }
  });
  wsClients.clear();

  server.close(() => {
    console.log('[Dashboard Server] ✅ Server closed');
    process.exit(0);
  });
});

// Export functions for use in main.js
module.exports = {
  setAgentManager,
  setMissionControlWindow,
  broadcastUpdate,
  calculateStats,
  startServer,
  PORT
};

// If this file is run directly (not required), start the server
if (require.main === module) {
  startServer();
  console.log('[Dashboard Server] Press Ctrl+C to stop');
}
