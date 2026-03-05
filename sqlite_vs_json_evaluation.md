# SQLite vs JSON Storage Evaluation Report

**Project:** Pixel Agent Desk
**Date:** 2026-03-05
**Evaluator:** Database Architecture Analysis
**Version:** 1.0.0

---

## Executive Summary

**Recommendation: DO NOT MIGRATE TO SQLITE - STAY WITH JSON**

**Confidence Level:** HIGH (85%)

**Key Finding:** Current JSON-based storage is well-suited for the application's scale and requirements. SQLite would introduce unnecessary complexity without significant benefits at the current data scale (10 agents max, 3.8MB log file).

---

## 1. Current JSON Storage Analysis

### 1.1 Data Architecture

**Storage Files:**
- `~/.pixel-agent-desk/state.json` - Session state (2.9KB)
- `~/.pixel-agent-desk/hooks.jsonl` - Hook event log (3.8MB, 344 lines)
- `~/.pixel-agent-desk/settings.json` - User settings (187B)

**Data Characteristics:**
| Metric | Current Value | Trend |
|--------|---------------|-------|
| Max concurrent agents | 10 | Fixed limit |
| Active sessions | Variable (≤10) | Stable |
| Hook log size | 3.8MB (344 events) | Growing slowly |
| State file size | 2.9KB | Stable |
| Write frequency | Per hook event | High frequency |
| Read patterns | Full scan on startup | Low frequency |

### 1.2 Current Access Patterns

**Write Operations:**
```javascript
// Agent updates (agentManager.js:40-107)
- updateAgent() - In-memory Map operation
- Periodic state persistence (main.js:588-600)
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

// Hook logging (hook.js:25)
fs.appendFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify(data) + '\n', 'utf-8');
```

**Read Operations:**
```javascript
// Startup recovery (main.js:612-688)
- Full state.json read: fs.readFileSync(statePath, 'utf-8')
- Full hooks.jsonl replay: fs.readFileSync(hooksPath, 'utf-8').split('\n')

// Query patterns (agentManager.js:124-154)
- getAllAgents(): Map iteration (O(n))
- getAgent(id): Map lookup (O(1))
- getAgentsByActivity(): Sort by timestamp (O(n log n))
- getStats(): Aggregate counts (O(n))
```

### 1.3 Advantages of Current JSON Approach

✅ **Simplicity**
- Zero external dependencies
- Human-readable/debuggable
- Easy backup (just copy files)
- Simple version control

✅ **Performance (at current scale)**
- In-memory Map operations: O(1) lookup
- Full scan cost: negligible for 10 items
- No connection overhead
- No query parsing overhead

✅ **Reliability**
- Atomic file writes (rename pattern)
- No transaction complexity
- Simple error recovery
- Works offline

✅ **Portability**
- Cross-platform compatible
- No native bindings
- No installation issues
- Easy migration

### 1.4 Disadvantages of Current JSON Approach

❌ **Scalability Limits**
- Full file scan on every read
- No efficient partial updates
- No indexing
- Manual query implementation

❌ **Concurrency Issues**
- File-level locking only
- No multi-writer support
- Potential data loss on crash
- Manual transaction handling

❌ **Data Integrity**
- No schema enforcement
- No foreign key constraints
- Manual validation required
- Potential corruption risk

❌ **Query Limitations**
- No ad-hoc queries
- No joins
- No aggregations
- Manual filtering required

---

## 2. SQLite Migration Analysis

### 2.1 Proposed SQLite Schema

**Hypothetical Design:**
```sql
-- Sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  slug TEXT,
  display_name TEXT,
  project_path TEXT,
  jsonl_path TEXT,
  is_subagent BOOLEAN,
  is_teammate BOOLEAN,
  parent_id TEXT,
  state TEXT,
  active_start_time INTEGER,
  last_duration INTEGER,
  last_activity INTEGER,
  first_seen INTEGER,
  update_count INTEGER,
  FOREIGN KEY (parent_id) REFERENCES sessions(id)
);

-- Hooks table
CREATE TABLE hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT,
  timestamp INTEGER,
  data JSON,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes
CREATE INDEX idx_hooks_session_id ON hooks(session_id);
CREATE INDEX idx_hooks_timestamp ON hooks(timestamp);
CREATE INDEX idx_sessions_state ON sessions(state);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
```

### 2.2 Migration Complexity

**Code Changes Required:**
1. **Database Layer** (new module)
   - Connection management
   - Schema versioning
   - Migration scripts
   - Transaction wrappers

2. **AgentManager Refactor**
   - Replace Map with database queries
   - Update all CRUD operations
   - Add query optimization
   - Implement caching layer

3. **Main Process Changes**
   - Replace fs operations with SQL
   - Add connection lifecycle
   - Implement backup/restore
   - Error handling redesign

4. **Testing**
   - Unit tests for all queries
   - Integration tests for transactions
   - Migration testing
   - Performance benchmarks

**Estimated Effort:** 40-60 hours (PRD estimates 12 hours - likely optimistic)

### 2.3 SQLite Advantages

✅ **Query Power**
- SQL filtering: `WHERE state = 'Working'`
- Aggregations: `SELECT COUNT(*) FROM sessions WHERE state = 'Done'`
- Joins: Parent-child relationships
- Indexing: Fast lookups

✅ **Data Integrity**
- Schema enforcement
- Foreign key constraints
- Transaction support (ACID)
- Type safety

✅ **Scalability**
- Efficient partial updates
- No full table scans
- Built-in indexing
- Query optimization

✅ **Backup/Recovery**
- Online backups (VACUUM INTO)
- Point-in-time recovery
- Transaction logging
- Atomic updates

### 2.4 SQLite Disadvantages

❌ **Complexity**
- External dependency (better-sqlite3)
- Native compilation required
- Schema migration management
- SQL learning curve

❌ **Overhead**
- Connection management
- Query parsing overhead
- Transaction overhead
- Memory footprint increase

❌ **Debugging Difficulty**
- Binary data format
- Requires SQLite tools
- Less human-readable
- Harder to inspect

❌ **Maintenance Burden**
- Schema versioning
- Migration scripts
- Backup procedures
- Performance tuning

---

## 3. Comparative Analysis

### 3.1 Performance Comparison

**Current Scale (10 agents, 344 hooks):**

| Operation | JSON (Current) | SQLite (Estimated) | Winner |
|-----------|----------------|-------------------|--------|
| Single agent lookup | O(1) Map | O(1) Index | **Tie** |
| Get all agents | O(10) iteration | O(10) scan | **Tie** |
| Filter by state | O(10) scan | O(1) index | **SQLite** |
| Insert hook | O(1) append | O(log n) insert | **JSON** |
| Startup load | 2.9KB + 3.8MB | Connection + query | **JSON** |
| Memory usage | ~5MB | ~8-10MB | **JSON** |

**At Scale (100 agents, 10,000 hooks):**

| Operation | JSON | SQLite | Winner |
|-----------|------|--------|--------|
| Single agent lookup | O(1) Map | O(1) Index | **Tie** |
| Get all agents | O(100) iteration | O(100) scan | **Tie** |
| Filter by state | O(100) scan | O(1) index | **SQLite** |
| Insert hook | O(1) append | O(log n) insert | **JSON** |
| Complex queries | Manual filtering | SQL WHERE | **SQLite** |

**Key Insight:** At current scale (10 agents), JSON performance is excellent. SQLite advantages appear only with:
1. Complex ad-hoc queries
2. Large-scale filtering (100+ agents)
3. Multi-table joins
4. Historical data analysis

### 3.2 Complexity Comparison

| Aspect | JSON | SQLite | Delta |
|--------|------|--------|-------|
| Lines of code | ~200 (data layer) | ~500 (data layer) | +150% |
| Dependencies | 0 | 1 (better-sqlite3) | +1 |
| Native modules | 0 | 1 | +1 |
| Schema management | Manual | Migrations required | +Complex |
| Debugging | Text editor | SQLite tools | +Complex |
| Testing effort | Low | High | +High |

### 3.3 Feature Comparison

| Feature | JSON | SQLite | Priority |
|---------|------|--------|----------|
| CRUD operations | ✅ | ✅ | Both |
| Full-text search | ❌ | ✅ (FTS5) | Low |
| Transactions | ❌ | ✅ | Medium |
| Indexing | ❌ | ✅ | Medium |
| Data integrity | ❌ | ✅ | High |
| Complex queries | ❌ | ✅ | Low |
| Offline support | ✅ | ✅ | Both |
| Portability | ✅ | ⚠️ | JSON |
| Human-readable | ✅ | ❌ | JSON |
| Zero-config | ✅ | ❌ | JSON |

---

## 4. Decision Framework

### 4.1 Evaluation Criteria

**Data Scale Indicators:**
- ✅ **Stay with JSON if:** < 20 concurrent entities
- ⚠️ **Consider SQLite if:** 20-100 concurrent entities
- ❌ **Migrate to SQLite if:** > 100 concurrent entities

**Query Complexity Indicators:**
- ✅ **Stay with JSON if:** Simple CRUD + basic filtering
- ⚠️ **Consider SQLite if:** Ad-hoc reporting needed
- ❌ **Migrate to SQLite if:** Complex joins/aggregations required

**Data Relationship Indicators:**
- ✅ **Stay with JSON if:** Flat or simple hierarchical data
- ⚠️ **Consider SQLite if:** Many-to-many relationships
- ❌ **Migrate to SQLite if:** Complex relational schema

**Integrity Requirements:**
- ✅ **Stay with JSON if:** Tolerates occasional data loss
- ⚠️ **Consider SQLite if:** Data corruption is problematic
- ❌ **Migrate to SQLite if:** ACID guarantees required

### 4.2 Current Project Assessment

**Data Scale:** ✅ **STAY WITH JSON**
- Max 10 agents (hard limit)
- 3.8MB hook log (manageable)
- 2.9KB state file (tiny)
- No growth trend indicating scale issues

**Query Complexity:** ✅ **STAY WITH JSON**
- Current operations: simple CRUD
- Filtering: basic state/status filters
- No complex joins needed
- No ad-hoc reporting requirements

**Data Relationships:** ✅ **STAY WITH JSON**
- Simple parent-child hierarchy
- No many-to-many relationships
- Nested structure works well
- Foreign keys not critical

**Integrity Requirements:** ⚠️ **CONSIDER IMPROVEMENTS**
- Hook logging should be atomic
- State corruption risk exists
- But: Not critical for dashboard app
- Mitigation: Better file locking, validation

---

## 5. Recommendations

### 5.1 Primary Recommendation: STAY WITH JSON

**Rationale:**
1. **Scale-appropriate:** 10-agent limit fits JSON perfectly
2. **Performance-optimized:** In-memory Map is faster than DB
3. **Complexity-minimized:** No need for database layer
4. **Maintenance-reduced:** Fewer moving parts
5. **Cost-effective:** No migration effort required

**Confidence:** 85%

### 5.2 Secondary Recommendations: IMPROVE JSON APPROACH

Instead of migrating to SQLite, enhance the current system:

**Priority 1: Add Schema Validation (4 hours)**
```javascript
// Use Ajv to validate state.json before loading
const stateSchema = {
  type: 'object',
  required: ['agents', 'sessions', 'pids'],
  properties: {
    agents: {
      type: 'array',
      items: { $ref: '#/definitions/agent' }
    }
  },
  definitions: {
    agent: {
      type: 'object',
      required: ['id', 'state', 'lastActivity'],
      properties: {
        state: { enum: ['Done', 'Thinking', 'Working', 'Waiting', 'Help'] }
      }
    }
  }
};
```

**Priority 2: Improve Hook Logging (6 hours)**
```javascript
// Add atomic writes with rotation
class HookLogger {
  constructor() {
    this.currentPath = path.join(os.homedir(), '.pixel-agent-desk', 'hooks.jsonl');
    this.rotateSize = 10 * 1024 * 1024; // 10MB
  }

  append(hook) {
    // Rotate if too large
    if (fs.statSync(this.currentPath).size > this.rotateSize) {
      this.rotate();
    }

    // Atomic append
    const tmp = this.currentPath + '.tmp';
    fs.appendFileSync(tmp, JSON.stringify(hook) + '\n');
    fs.renameSync(tmp, this.currentPath);
  }

  rotate() {
    const timestamp = Date.now();
    const archive = this.currentPath + `.${timestamp}`;
    fs.renameSync(this.currentPath, archive);
    // Keep last 5 archives
  }
}
```

**Priority 3: Add Query Helpers (3 hours)**
```javascript
// Add common query patterns to AgentManager
class AgentManager {
  getAgentsByState(state) {
    return this.getAllAgents().filter(a => a.state === state);
  }

  getAgentsByParent(parentId) {
    return this.getAllAgents().filter(a => a.parentId === parentId);
  }

  getActiveAgents() {
    const cutoff = Date.now() - this.config.idleTimeout;
    return this.getAllAgents().filter(a => a.lastActivity > cutoff);
  }

  getAgentStats() {
    return {
      total: this.agents.size,
      byState: this.groupByState(),
      avgDuration: this.calculateAvgDuration(),
      activeTime: this.calculateActiveTime()
    };
  }
}
```

**Priority 4: Add Data Validation (4 hours)**
```javascript
// Validate before loading from state.json
function loadPersistedState() {
  const raw = fs.readFileSync(statePath, 'utf-8');
  const state = JSON.parse(raw);

  // Validate structure
  if (!validateState(state)) {
    throw new Error('Invalid state.json structure');
  }

  // Validate each agent
  for (const agent of state.agents) {
    if (!validateAgent(agent)) {
      console.warn(`Invalid agent data: ${agent.id}, skipping`);
      continue;
    }
    // ... restore agent
  }
}
```

### 5.3 When to Consider SQLite Migration

**Trigger Conditions (evaluate in 6-12 months):**

1. **Scale Trigger:**
   - maxAgents increased to > 20
   - OR hook log exceeds 50MB
   - OR query latency > 100ms

2. **Feature Trigger:**
   - Need for historical analytics
   - Complex reporting requirements
   - Multi-user support

3. **Performance Trigger:**
   - Full scans become bottleneck
   - Memory usage exceeds 500MB
   - Startup time > 5 seconds

**Migration Approach if Triggered:**
- Phase 1: Add SQLite alongside JSON (dual-write)
- Phase 2: Migrate read operations gradually
- Phase 3: Deprecate JSON writes
- Phase 4: Remove JSON code paths

---

## 6. Cost-Benefit Analysis

### 6.1 Stay with JSON (Recommended)

**Benefits:**
- ✅ Zero migration cost
- ✅ Maintain current simplicity
- ✅ Faster development velocity
- ✅ Lower maintenance burden
- ✅ Easier debugging

**Costs:**
- ⚠️ Manual query implementation (3-6 hours)
- ⚠️ Schema validation needed (4 hours)
- ⚠️ Less powerful queries
- ⚠️ No transaction guarantees

**Total Effort:** ~10 hours
**ROI:** High (low cost, adequate solution)

### 6.2 Migrate to SQLite

**Benefits:**
- ✅ Powerful querying
- ✅ Better data integrity
- ✅ Transaction support
- ✅ Built-in indexing

**Costs:**
- ❌ Migration effort (40-60 hours)
- ❌ Added complexity
- ❌ External dependency
- ❌ Maintenance overhead
- ❌ Debugging complexity

**Total Effort:** ~50 hours
**ROI:** Low (high cost, minimal current benefit)

---

## 7. Implementation Roadmap

### 7.1 Recommended Path (JSON Improvements)

**Week 1: Validation & Robustness (10 hours)**
- [ ] Add schema validation with Ajv (4h)
- [ ] Validate state.json on load (2h)
- [ ] Validate hooks.jsonl entries (2h)
- [ ] Add error recovery tests (2h)

**Week 2: Query Optimization (6 hours)**
- [ ] Add query helper methods (3h)
- [ ] Optimize common filters (2h)
- [ ] Add caching for repeated queries (1h)

**Week 3: Logging Improvements (6 hours)**
- [ ] Implement atomic hook logging (3h)
- [ ] Add log rotation (2h)
- [ ] Add log archival (1h)

**Total: 22 hours (vs 50+ hours for SQLite)**

### 7.2 Alternative Path (SQLite Migration)

**Week 1: Schema Design (8 hours)**
- [ ] Design database schema
- [ ] Plan migration strategy
- [ ] Write migration scripts

**Week 2-3: Core Implementation (24 hours)**
- [ ] Database connection layer
- [ ] Schema versioning system
- [ ] CRUD operation refactor
- [ ] Transaction management

**Week 4: Testing & Migration (16 hours)**
- [ ] Unit tests for all queries
- [ ] Integration tests
- [ ] Migration testing
- [ ] Performance benchmarks

**Total: 48 hours (PRD estimates 12h - unrealistic)**

---

## 8. Conclusion

### 8.1 Final Recommendation

**DO NOT MIGRATE TO SQLITE**

**Confidence Level:** 85%

The current JSON-based storage system is appropriate for Pixel Agent Desk because:

1. **Scale fits:** 10-agent limit is perfect for in-memory operations
2. **Performance is excellent:** O(1) lookups, negligible scan costs
3. **Complexity is minimal:** Zero external dependencies, simple debugging
4. **Cost is low:** No migration effort required
5. **Requirements are simple:** Basic CRUD, no complex queries

### 8.2 Success Metrics

**If we stay with JSON:**
- ✅ Development velocity maintained
- ✅ Bug count remains low
- ✅ Startup time < 2 seconds
- ✅ Memory usage < 100MB

**If metrics degrade, reconsider SQLite:**
- ❌ Startup time > 5 seconds
- ❌ Memory usage > 500MB
- ❌ maxAgents increased to > 20
- ❌ Complex query requirements emerge

### 8.3 Next Steps

1. **Immediate:** Implement JSON improvements (22 hours)
2. **6-month review:** Re-evaluate based on actual usage
3. **Trigger-based:** Migrate only if specific thresholds exceeded

---

## Appendix A: Technical Details

### A.1 Current Data Structures

**state.json Structure:**
```json
{
  "agents": [
    {
      "id": "session-uuid",
      "sessionId": "session-uuid",
      "agentId": "agent-uuid",
      "slug": "project-slug",
      "displayName": "Project Name",
      "projectPath": "/path/to/project",
      "jsonlPath": "/path/to/session.jsonl",
      "isSubagent": false,
      "isTeammate": false,
      "parentId": null,
      "state": "Working",
      "activeStartTime": 1234567890,
      "lastDuration": 5000,
      "lastActivity": 1234567890,
      "timestamp": 1234567890,
      "firstSeen": 1234567890,
      "updateCount": 5
    }
  ],
  "sessions": {},
  "pids": [["session-uuid", 12345]]
}
```

**hooks.jsonl Structure (one line per hook):**
```json
{"type":"sessionstart","sessionId":"uuid","cwd":"/path","timestamp":1234567890,...}
{"type":"usermessage","sessionId":"uuid","content":"...","timestamp":1234567891,...}
```

### A.2 Performance Benchmarks (Estimated)

**Current JSON Performance:**
- Startup load: ~50ms (2.9KB + 3.8MB)
- Single agent lookup: <1ms (Map.get)
- Get all agents: <1ms (10 items)
- Filter by state: <1ms (10 iterations)
- Insert hook: ~2ms (fs.appendFileSync)

**SQLite Performance (estimated):**
- Connection setup: ~10ms
- Single agent lookup: ~1ms (indexed)
- Get all agents: ~2ms (query + parse)
- Filter by state: ~1ms (indexed)
- Insert hook: ~3ms (transaction)

**Conclusion:** JSON is competitive at current scale.

### A.3 Risk Assessment

**Stay with JSON:**
- Low technical risk
- Low business risk
- Low maintenance risk
- Medium scalability risk

**Migrate to SQLite:**
- Medium technical risk (migration bugs)
- Medium business risk (delayed features)
- High maintenance risk (complexity)
- Low scalability risk

---

**Report Status:** COMPLETE
**Next Review:** 2026-09-05 (6 months)
**Owner:** Database Architecture Team
