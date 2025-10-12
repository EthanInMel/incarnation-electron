import {join} from 'node:path'
import {app} from 'electron'
import {createRequire} from 'node:module'
import * as fs from 'node:fs'

export type Db = ReturnType<typeof createDb>

function loadDriver(): {kind:'better'; Driver:any} | {kind:'raw'; Driver:any} | null {
  try {
    const req = createRequire(import.meta.url)
    // Try sqlite-electron first (if it exposes sqlite3-like Database with prepare)
    try {
      const se = req('sqlite-electron')
      if (se && (se as any).Database) {
        return {kind:'better', Driver: se}
      }
    } catch {}
    // Fallback to better-sqlite3 (recommended)
    const mod = req('better-sqlite3')
    return {kind:'raw', Driver: mod}
  } catch (e) {
    try { console.warn('[db] better-sqlite3 load failed:', e) } catch {}
    return null
  }
}

export function createDb() {
  const userData = app.getPath('userData')
  const file = join(userData, 'incarnation.db')
  const driverInfo = loadDriver()
  if (!driverInfo) {
    // Fallback JSON store (no native deps)
    const jsonFile = join(userData, 'incarnation.sqlite.json')
    type Row = Record<string, any>
    type Dump = {sessions: Row[]; events: Row[]; llm_calls: Row[]}
    const empty: Dump = {sessions: [], events: [], llm_calls: []}
    const load = (): Dump => { try { return JSON.parse(fs.readFileSync(jsonFile, 'utf8')) } catch { return {...empty} } }
    const save = (d: Dump) => { try { fs.writeFileSync(jsonFile, JSON.stringify(d), 'utf8') } catch {} }
    const data: Dump = load()
    console.warn('[db] Using JSON fallback store at', jsonFile)
    function ensureSession(id: string, meta?: any) {
      const found = data.sessions.find(s => s.id === id)
      if (!found) data.sessions.push({id, created_at: Date.now(), meta: meta ?? null})
      else if (meta != null) found.meta = meta
      save(data)
    }
    function addEvent(sessionId: string, kind: string, payload: any, ts?: number) {
      data.events.push({session_id: sessionId, ts: ts || Date.now(), kind, payload})
      save(data)
    }
    function addLLMCall(args: {sessionId: string; turn?: number; phase?: string; provider?: string; model?: string; request?: any; response?: any; error?: any; elapsedMs?: number}) {
      data.llm_calls.push({
        session_id: args.sessionId,
        turn: args.turn ?? null,
        phase: args.phase ?? null,
        provider: args.provider ?? null,
        model: args.model ?? null,
        request: args.request ?? null,
        response: args.response ?? null,
        error: args.error ?? null,
        elapsed_ms: Number(args.elapsedMs ?? 0),
        created_at: Date.now(),
      })
      save(data)
    }
    function listSessions(limit = 100, offset = 0) {
      const sorted = [...data.sessions].sort((a,b)=> (b.created_at||0)-(a.created_at||0))
      return sorted.slice(offset, offset+limit)
    }
    function getReplay(sessionId: string) {
      const sess = data.sessions.find(s=> s.id===sessionId) || null
      const events = data.events.filter(e=> e.session_id===sessionId).sort((a,b)=> (a.ts||0)-(b.ts||0))
      const llm = data.llm_calls.filter(e=> e.session_id===sessionId)
      return {session: sess, events, llm}
    }
    function saveConfig(provider: string, cfg: any) {
      const blob = (data as any).configs || {}
      blob[provider] = cfg || {}
      ;(data as any).configs = blob
      save(data)
    }
    function loadConfig(provider: string): any | null {
      const blob = (data as any).configs || {}
      return blob[provider] || null
    }
    function setCurrentProvider(provider: string) {
      ;(data as any).__currentProvider = provider
      save(data)
    }
    function getCurrentProvider(): string | null {
      return (data as any).__currentProvider || null
    }
    return {ensureSession, addEvent, addLLMCall, listSessions, getReplay, saveConfig, loadConfig, setCurrentProvider, getCurrentProvider}
  }
  // Instantiate DB depending on driver
  const db = driverInfo.kind==='better' ? new (driverInfo as any).Driver.Database(file) : new (driverInfo as any).Driver(file)
  db.pragma('journal_mode = WAL')

  db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER,
  phase TEXT,
  provider TEXT,
  model TEXT,
  request TEXT,
  response TEXT,
  error TEXT,
  elapsed_ms INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS configs (
  provider TEXT PRIMARY KEY,
  cfg TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

  const insSession = db.prepare(`INSERT OR IGNORE INTO sessions (id, created_at, meta) VALUES (@id, @created_at, @meta)`) 
  const insEvent = db.prepare(`INSERT INTO events (session_id, ts, kind, payload) VALUES (@session_id, @ts, @kind, @payload)`) 
  const insLLM = db.prepare(`INSERT INTO llm_calls (session_id, turn, phase, provider, model, request, response, error, elapsed_ms, created_at) VALUES (@session_id, @turn, @phase, @provider, @model, @request, @response, @error, @elapsed_ms, @created_at)`) 
  const upsertCfg = db.prepare(`INSERT INTO configs (provider, cfg, updated_at) VALUES (@provider, @cfg, @updated_at)
    ON CONFLICT(provider) DO UPDATE SET cfg=excluded.cfg, updated_at=excluded.updated_at`)
  const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
  const getMeta = db.prepare(`SELECT value FROM meta WHERE key=?`)
  const getCfg = db.prepare(`SELECT cfg FROM configs WHERE provider=?`)

  function ensureSession(id: string, meta?: any) {
    insSession.run({id, created_at: Date.now(), meta: meta ? JSON.stringify(meta) : null})
  }

  function addEvent(sessionId: string, kind: string, payload: any, ts?: number) {
    insEvent.run({session_id: sessionId, ts: ts || Date.now(), kind, payload: JSON.stringify(payload ?? null)})
  }

  function addLLMCall(args: {sessionId: string; turn?: number; phase?: string; provider?: string; model?: string; request?: any; response?: any; error?: any; elapsedMs?: number}) {
    insLLM.run({
      session_id: args.sessionId,
      turn: args.turn ?? null,
      phase: args.phase ?? null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      request: args.request ? JSON.stringify(args.request) : null,
      response: args.response ? JSON.stringify(args.response) : null,
      error: args.error ? JSON.stringify(args.error) : null,
      elapsed_ms: Number(args.elapsedMs ?? 0),
      created_at: Date.now(),
    })
  }

  function listSessions(limit = 100, offset = 0) {
    return db.prepare(`SELECT id, created_at, meta FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
  }

  function getReplay(sessionId: string) {
    const sess = db.prepare(`SELECT id, created_at, meta FROM sessions WHERE id=?`).get(sessionId)
    const events = db.prepare(`SELECT ts, kind, payload FROM events WHERE session_id=? ORDER BY ts ASC`).all(sessionId)
    const llm = db.prepare(`SELECT turn, phase, provider, model, request, response, error, elapsed_ms, created_at FROM llm_calls WHERE session_id=? ORDER BY id ASC`).all(sessionId)
    return {session: sess, events, llm}
  }

  function saveConfig(provider: string, cfg: any) {
    try { upsertCfg.run({provider, cfg: JSON.stringify(cfg||{}), updated_at: Date.now()}) } catch {}
  }
  function loadConfig(provider: string): any | null {
    try { const row = getCfg.get(provider); return row?.cfg ? JSON.parse(String(row.cfg)) : null } catch { return null }
  }
  function setCurrentProvider(provider: string) {
    try { setMeta.run({key:'current_provider', value: provider}) } catch {}
  }
  function getCurrentProvider(): string | null {
    try { const row = getMeta.get('current_provider'); return row?.value || null } catch { return null }
  }

  return {db, ensureSession, addEvent, addLLMCall, listSessions, getReplay, saveConfig, loadConfig, setCurrentProvider, getCurrentProvider}
}
