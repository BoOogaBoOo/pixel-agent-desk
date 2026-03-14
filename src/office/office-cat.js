/**
 * Office Cat — Roaming NPC that wanders between idle spots.
 * Pure cosmetic. Uses existing pathfinding. Drawn as a simple pixel sprite.
 */

/* eslint-disable no-unused-vars */

var officeCat = {
  x: 400,
  y: 400,
  targetX: 400,
  targetY: 400,
  path: [],
  pathIndex: 0,
  state: 'sleeping',  // sleeping, walking, sitting, grooming
  stateTimer: 0,
  facingDir: 'down',
  animFrame: 0,
  animTimer: 0,

  init: function () {
    // Start at a random idle spot
    if (officeCoords.idle && officeCoords.idle.length > 0) {
      var spot = officeCoords.idle[Math.floor(Math.random() * officeCoords.idle.length)];
      this.x = spot.x;
      this.y = spot.y;
    }
    this.stateTimer = 5000 + Math.random() * 10000; // sleep 5-15s initially
  },

  update: function (deltaMs) {
    this.stateTimer -= deltaMs;
    this.animTimer += deltaMs;

    if (this.state === 'sleeping' || this.state === 'sitting' || this.state === 'grooming') {
      if (this.stateTimer <= 0) {
        // Time to move
        this._pickNewTarget();
        this.state = 'walking';
      }
    } else if (this.state === 'walking') {
      this._move(deltaMs);
      if (this.path.length === 0 || this.pathIndex >= this.path.length) {
        // Arrived — pick a resting state
        var states = ['sleeping', 'sitting', 'grooming'];
        this.state = states[Math.floor(Math.random() * states.length)];
        this.stateTimer = 8000 + Math.random() * 20000; // rest 8-28s
      }
    }
  },

  _pickNewTarget: function () {
    if (!officeCoords.idle || officeCoords.idle.length === 0) return;
    var spot = officeCoords.idle[Math.floor(Math.random() * officeCoords.idle.length)];
    if (typeof officePathfinder !== 'undefined') {
      this.path = officePathfinder.findPath(this.x, this.y, spot.x, spot.y);
      this.pathIndex = 0;
    } else {
      this.x = spot.x;
      this.y = spot.y;
    }
  },

  _move: function (deltaMs) {
    if (this.pathIndex >= this.path.length) return;
    var target = this.path[this.pathIndex];
    var dx = target.x - this.x;
    var dy = target.y - this.y;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 3) {
      this.x = target.x;
      this.y = target.y;
      this.pathIndex++;
    } else {
      var speed = 50 * (deltaMs / 1000); // slower than agents
      this.x += (dx / dist) * speed;
      this.y += (dy / dist) * speed;
      this.facingDir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  },

  draw: function (ctx) {
    var cx = Math.round(this.x);
    var cy = Math.round(this.y);

    ctx.save();

    // Cat body (small pixel sprite — 8x6 px)
    var bodyColor = '#4a4a4a';
    var earColor = '#3a3a3a';
    var eyeColor = '#88ff88';

    if (this.state === 'sleeping') {
      // Sleeping cat — curled up ball
      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.ellipse(cx, cy - 2, 5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      // Tail curl
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx + 3, cy - 2, 3, -0.5, 1.8);
      ctx.stroke();
      // Zzz
      if (this.animTimer % 2000 < 1000) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '6px monospace';
        ctx.fillText('z', cx + 5, cy - 7);
        ctx.font = '5px monospace';
        ctx.fillText('z', cx + 8, cy - 10);
      }
    } else if (this.state === 'walking') {
      // Walking cat — side view
      var legOffset = Math.sin(this.animTimer / 150) * 2;
      ctx.fillStyle = bodyColor;
      // Body
      ctx.fillRect(cx - 4, cy - 5, 8, 4);
      // Head
      ctx.fillRect(cx + (this.facingDir === 'left' ? -6 : 2), cy - 7, 4, 4);
      // Ears
      ctx.fillStyle = earColor;
      var headX = cx + (this.facingDir === 'left' ? -6 : 2);
      ctx.fillRect(headX, cy - 8, 1, 2);
      ctx.fillRect(headX + 3, cy - 8, 1, 2);
      // Legs
      ctx.fillStyle = bodyColor;
      ctx.fillRect(cx - 3, cy - 1, 1, 3 + legOffset);
      ctx.fillRect(cx + 2, cy - 1, 1, 3 - legOffset);
      // Tail
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + (this.facingDir === 'left' ? 4 : -4), cy - 4);
      ctx.quadraticCurveTo(cx + (this.facingDir === 'left' ? 7 : -7), cy - 8, cx + (this.facingDir === 'left' ? 6 : -6), cy - 10);
      ctx.stroke();
      // Eyes
      ctx.fillStyle = eyeColor;
      ctx.fillRect(headX + 1, cy - 6, 1, 1);
      ctx.fillRect(headX + 2, cy - 6, 1, 1);
    } else {
      // Sitting / grooming — front facing
      ctx.fillStyle = bodyColor;
      // Body
      ctx.fillRect(cx - 3, cy - 5, 6, 5);
      // Head
      ctx.fillRect(cx - 3, cy - 9, 6, 5);
      // Ears
      ctx.fillStyle = earColor;
      ctx.fillRect(cx - 3, cy - 10, 2, 2);
      ctx.fillRect(cx + 1, cy - 10, 2, 2);
      // Eyes
      ctx.fillStyle = eyeColor;
      ctx.fillRect(cx - 2, cy - 7, 1, 1);
      ctx.fillRect(cx + 1, cy - 7, 1, 1);
      // Tail
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + 3, cy - 2);
      ctx.quadraticCurveTo(cx + 6, cy - 1, cx + 5, cy + 1);
      ctx.stroke();

      if (this.state === 'grooming') {
        // Grooming — paw near face
        ctx.fillStyle = bodyColor;
        ctx.fillRect(cx - 4, cy - 7, 2, 2);
      }
    }

    ctx.restore();
  },
};
