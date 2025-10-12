import {join} from 'node:path'
import {app} from 'electron'
import {createRequire} from 'node:module'

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
    // Fallback no-op DB to avoid crash; logs will be disabled until native module rebuilt
    const noop = {
      ensureSession: (_id: string, _meta?: any)=>{},
      addEvent: (_sid: string, _kind: string, _payload: any)=>{},
      addLLMCall: (_args: any)=>{},
      listSessions: (_limit?: number, _offset?: number)=>[],
      getReplay: (_sid: string)=> ({session:null, events:[], llm:[]}),
    }
    console.warn('[db] Running with no-op DB (better-sqlite3 unavailable). Run: npm run rebuild:native')
    return noop
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
`)

  const insSession = db.prepare(`INSERT OR IGNORE INTO sessions (id, created_at, meta) VALUES (@id, @created_at, @meta)`) 
  const insEvent = db.prepare(`INSERT INTO events (session_id, ts, kind, payload) VALUES (@session_id, @ts, @kind, @payload)`) 
  const insLLM = db.prepare(`INSERT INTO llm_calls (session_id, turn, phase, provider, model, request, response, error, elapsed_ms, created_at) VALUES (@session_id, @turn, @phase, @provider, @model, @request, @response, @error, @elapsed_ms, @created_at)`) 

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

  return {db, ensureSession, addEvent, addLLMCall, listSessions, getReplay}
}
