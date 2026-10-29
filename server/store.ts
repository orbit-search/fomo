/** A local, durable event journal. Never replay interrupted paid or state-changing operations. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Session,
  Event,
  Message,
  Artifact,
  Approval,
  SessionStatus,
} from '../shared/types.ts';
const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, 'fomo.sqlite'));
    chmodSync(join(dir, 'fomo.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT,createdAt TEXT,updatedAt TEXT,status TEXT);
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,turnId TEXT,kind TEXT,data TEXT,at TEXT);
   CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,body TEXT);
   CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,provider TEXT,kind TEXT,title TEXT,data TEXT,createdAt TEXT);
   CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,turnId TEXT,tool TEXT,args TEXT,detail TEXT,status TEXT,createdAt TEXT);
   CREATE TABLE IF NOT EXISTS operations(sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,key TEXT,status TEXT,data TEXT,PRIMARY KEY(sessionId,key));
   CREATE TABLE IF NOT EXISTS turns(sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,clientId TEXT,turnId TEXT,PRIMARY KEY(sessionId,clientId));`);
  }
  create() {
    const at = now();
    const s: Session = {
      id: randomUUID(),
      title: 'Untitled session',
      createdAt: at,
      updatedAt: at,
      status: 'idle',
    };
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(s.id, s.title, at, at, s.status);
    return s;
  }
  list() {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updatedAt DESC')
      .all() as unknown as Session[];
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as unknown as
      Session | undefined;
  }
  status(id: string, status: SessionStatus) {
    this.db.prepare('UPDATE sessions SET status=?,updatedAt=? WHERE id=?').run(status, now(), id);
  }
  title(id: string, title: string) {
    this.db
      .prepare('UPDATE sessions SET title=? WHERE id=? AND title=?')
      .run(title.slice(0, 72), id, 'Untitled session');
  }
  event(sessionId: string, turnId: string, kind: Event['kind'], data: Record<string, unknown>) {
    const at = now();
    const r = this.db
      .prepare('INSERT INTO events(sessionId,turnId,kind,data,at) VALUES(?,?,?,?,?)')
      .run(sessionId, turnId, kind, JSON.stringify(data), at);
    return { id: Number(r.lastInsertRowid), sessionId, turnId, kind, data, at };
  }
  events(id: string, after = 0) {
    return this.db
      .prepare('SELECT * FROM events WHERE sessionId=? AND id>? ORDER BY id LIMIT 10000')
      .all(id, after)
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })) as unknown as Event[];
  }
  message(id: string, m: Message) {
    this.db.prepare('INSERT INTO messages(sessionId,body) VALUES(?,?)').run(id, JSON.stringify(m));
  }
  messages(id: string) {
    return this.db
      .prepare('SELECT body FROM messages WHERE sessionId=? ORDER BY id')
      .all(id)
      .map((x) => JSON.parse(String(x.body)) as Message);
  }
  artifact(a: Omit<Artifact, 'id' | 'createdAt'>, key?: string) {
    const id = key ?? randomUUID();
    const at = now();
    this.db
      .prepare('INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?,?,?,?)')
      .run(id, a.sessionId, a.provider, a.kind, a.title, JSON.stringify(a.data), at);
    return id;
  }
  artifacts(id: string) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE sessionId=? ORDER BY createdAt DESC')
      .all(id)
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })) as unknown as Artifact[];
  }
  approval(a: Omit<Approval, 'status' | 'createdAt'>) {
    this.db
      .prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?)')
      .run(
        a.id,
        a.sessionId,
        a.turnId,
        a.tool,
        JSON.stringify(a.args),
        JSON.stringify(a.detail),
        'pending',
        now(),
      );
  }
  approvals(id: string) {
    return this.db
      .prepare('SELECT * FROM approvals WHERE sessionId=? ORDER BY createdAt')
      .all(id)
      .map((r) => ({
        ...r,
        args: JSON.parse(String(r.args)),
        detail: JSON.parse(String(r.detail)),
      })) as unknown as Approval[];
  }
  resolveApproval(id: string, approved: boolean) {
    return (
      this.db
        .prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'")
        .run(approved ? 'approved' : 'denied', id).changes > 0
    );
  }
  operation(id: string, key: string) {
    const r = this.db
      .prepare('SELECT status,data FROM operations WHERE sessionId=? AND key=?')
      .get(id, key);
    return r
      ? { status: String(r.status), data: JSON.parse(String(r.data)) as Record<string, unknown> }
      : undefined;
  }
  operationSet(id: string, key: string, status: string, data: Record<string, unknown>) {
    this.db
      .prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?,?)')
      .run(id, key, status, JSON.stringify(data));
  }
  turn(id: string, clientId: string) {
    return this.db
      .prepare('SELECT turnId FROM turns WHERE sessionId=? AND clientId=?')
      .get(id, clientId)?.turnId as string | undefined;
  }
  registerTurn(id: string, clientId: string, turnId: string) {
    this.db.prepare('INSERT INTO turns VALUES(?,?,?)').run(id, clientId, turnId);
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }
  recover() {
    for (const s of this.list().filter((x) => x.status !== 'idle')) {
      const events = this.events(s.id);
      const turnId = events.at(-1)?.turnId || 'interrupted';
      const messages = this.messages(s.id);
      const answered = new Set(
        messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
      );
      for (const m of messages)
        for (const c of m.tool_calls ?? [])
          if (!answered.has(c.id))
            this.message(s.id, {
              role: 'tool',
              tool_call_id: c.id,
              content: JSON.stringify({
                error: 'interrupted',
                message:
                  'Server restarted. The operation may have executed; do not repeat automatically.',
              }),
            });
      for (const a of this.approvals(s.id).filter((x) => x.status === 'pending'))
        this.resolveApproval(a.id, false);
      this.event(s.id, turnId, 'error', {
        message: 'The server restarted during this turn. Pending operations were not replayed.',
      });
      this.event(s.id, turnId, 'done', { status: 'interrupted' });
      this.status(s.id, 'idle');
    }
  }
  close() {
    this.db.close();
  }
}
