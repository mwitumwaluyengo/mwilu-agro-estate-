/* =====================================================================
   MWILU AGRO ESTATE – Cloudflare Pages backend (advanced-mode worker)
   Database : Cloudflare D1  (binding name must be  DB )
   Optional : environment variables ADMIN_PIN, OWNER_PIN, MANAGER_PIN
              (used ONLY the very first time, to create the 3 starter accounts)
   Everything under /api/* is handled here; every other URL is the static site.
   ===================================================================== */

const CHUNK = 900000;                 // bytes per file chunk stored in D1
const MAX_FILE = 15 * 1024 * 1024;    // 15 MB per uploaded file
const MAX_ROW = 1800000;              // D1 limit is 2 MB per row
const TOKEN_HOURS = 12;
const enc = new TextEncoder();

/* ---------------- ACCESS POLICY (edit here if you add new modules) ---------------- */
const EXTERNAL = new Set(['applicant', 'employee', 'caretaker']);       // outside users
const SUPER = new Set(['admin', 'owner']);                              // full control

// what a visitor who is NOT logged in may read (collection names without the leading @)
const PUBLIC_READ = new Set(['news', 'goats', 'vacs', 'settings', 'hbg', 'shopset', 'sitems', 'scats', 'spromo',
  'agItem', 'agSet', 'agTrn', 'agAct', 'agOpp', 'seq', '']);
// what a visitor who is NOT logged in may ADD (never change / delete) – applications, orders, registrations
const ANON_ADD = new Set(['users', 'cands', 'gapps', 'gnot', 'audit', 'sord', 'spay', 'senq', 'agEnq', 'seq']);
const ANON_MOD = new Set(['seq', 'goats']);   // goats: a new application reserves a goat; seq: id counters
// applicants / employees / caretakers: shared reference data they may read in full
const EXT_SHARED = new Set([...PUBLIC_READ, 'roles', 'lvt', 'lvset', 'xset', 'hrset']);
// … and personal data they may read only when it belongs to them
const EXT_PERSONAL = new Set(['cands', 'leaves', 'lvx', 'emps', 'gapps', 'apps', 'gasg', 'alloc', 'shares', 'kids',
  'births', 'breed', 'agr', 'gnot', 'hriss', 'gho', 'gal', 'lapp', 'sord', 'spay', 'senq', 'agEnq', 'inc', 'own']);
// outside users may NOT change these at all
const EXT_NOWRITE = new Set(['roles', 'settings', 'shopset', 'xset', 'hrset', 'lvset', 'mgmt', 'agSet', 'hbg', 'news',
  'vacs', 'emps', 'pays', 'fin', 'lvt', 'scats', 'sitems', 'spromo', 'agItem', 'agTrn', 'agAct', 'agOpp', 'vets',
  'insp', 'fvis', 'smov', 'ctr', 'sref']);
// only admin / owner may change these
const SUPER_ONLY = new Set(['roles', 'settings', 'hbg']);
// fields an applicant must not change on their own application
const CAND_PROTECTED = ['status', 'offer', 'int', 'scr', 'sl', 'res', 'emp'];

const base = c => (c[0] === '@' ? c.slice(1) : c);

/* ---------------- small helpers ---------------- */
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const pj = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const eq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

let READY = false, SECRET = null;

async function ensure(env) {
  if (READY) return;
  const db = env.DB;
  if (!db) throw new Error('D1 binding "DB" is missing. Pages project > Settings > Bindings > add D1 database with variable name DB.');
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS rec(c TEXT NOT NULL, id TEXT NOT NULL, v TEXT, ord REAL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(c,id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS rec_rev ON rec(rev)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, val TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, owner TEXT, size INTEGER, n INTEGER, meta TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS fchunks(id TEXT NOT NULL, i INTEGER NOT NULL, data BLOB, PRIMARY KEY(id,i))'),
    db.prepare('CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY, n INTEGER, ts INTEGER)'),
    db.prepare("INSERT OR IGNORE INTO meta(k,val) VALUES('rev','0')")
  ]);
  const seeded = await db.prepare("SELECT val FROM meta WHERE k='seeded'").first();
  if (!seeded) {
    const mk = (u, name, role, pin) => JSON.stringify({ u, p: String(pin), name, role });
    const rows = [
      ['admin', 'System Administrator', 'admin', env.ADMIN_PIN || '1234'],
      ['owner', 'Estate Owner', 'owner', env.OWNER_PIN || '1234'],
      ['manager', 'Livestock Officer', 'manager', env.MANAGER_PIN || '1234']
    ];
    await db.batch([
      db.prepare("UPDATE meta SET val=CAST(val AS INTEGER)+1 WHERE k='rev'"),
      ...rows.map((r, i) => db.prepare("INSERT OR IGNORE INTO rec(c,id,v,ord,rev) VALUES('users',?,?,?,(SELECT CAST(val AS INTEGER) FROM meta WHERE k='rev'))").bind('u:' + r[0], mk(...r), i)),
      db.prepare("INSERT OR IGNORE INTO meta(k,val) VALUES('seeded','1')")
    ]);
  }
  READY = true;
}

async function secret(db) {
  if (SECRET) return SECRET;
  let r = await db.prepare("SELECT val FROM meta WHERE k='secret'").first();
  if (!r) {
    const s = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare("INSERT OR IGNORE INTO meta(k,val) VALUES('secret',?)").bind(s).run();
    r = await db.prepare("SELECT val FROM meta WHERE k='secret'").first();
  }
  return (SECRET = r.val);
}
async function sign(db, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(await secret(db)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}
async function makeToken(db, u, role) {
  const p = b64u(enc.encode(JSON.stringify({ u, r: role, e: Date.now() + TOKEN_HOURS * 3600e3 })));
  return p + '.' + await sign(db, p);
}
async function getUser(db, u) {
  const r = await db.prepare("SELECT v FROM rec WHERE c='users' AND id=? AND v IS NOT NULL").bind('u:' + u).first();
  return r ? pj(r.v) : null;
}
async function auth(request, env) {
  const h = request.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s || !eq(s, await sign(env.DB, p))) return null;
  const d = pj(new TextDecoder().decode(unb64u(p)));
  if (!d || d.e < Date.now()) return null;
  const user = await getUser(env.DB, d.u);
  if (!user || user.disabled || user.role !== d.r) return null;      // role change / disabling takes effect at once
  return { u: user.u, role: user.role, user };
}

/* ---------------- reading with per-role filtering ---------------- */
async function currentRev(db) { return +((await db.prepare("SELECT val FROM meta WHERE k='rev'").first()).val); }

async function identity(db, ctx) {
  const ids = new Set([ctx.u]);
  if (ctx.user.crt) ids.add(String(ctx.user.crt));
  if (ctx.user.emp) ids.add(String(ctx.user.emp));
  const rs = (await db.prepare(`SELECT c,id,v FROM rec WHERE v IS NOT NULL AND (${[...EXT_PERSONAL].map(() => 'c=?').join(' OR ')})`).bind(...EXT_PERSONAL).all()).results;
  const objs = rs.map(r => ({ r, o: pj(r.v) })).filter(x => x.o && typeof x.o === 'object');
  for (let pass = 0; pass < 2; pass++) {
    for (const { o } of objs) {
      if (o.id != null && ids.has(String(o.id))) continue;
      for (const k in o) { const val = o[k]; if ((typeof val === 'string' || typeof val === 'number') && ids.has(String(val))) { if (o.id != null) ids.add(String(o.id)); break; } }
    }
  }
  return ids;
}
function ownedBy(o, ids, raw, ctx, c) {
  if (c === 'gnot' && (raw.includes('USER:' + ctx.u) || raw.includes('ROLE:' + ctx.role))) return true;
  if (!o || typeof o !== 'object') return false;
  for (const k in o) { const val = o[k]; if ((typeof val === 'string' || typeof val === 'number') && ids.has(String(val))) return true; }
  return false;
}
async function shape(db, rows, ctx, full = true) {
  const out = [];
  let ids = null;
  for (const r of rows) {
    const b = base(r.c);
    if (!ctx) {                                                    // not logged in
      if (r.c === 'users') { if (r.v != null) out.push({ c: r.c, i: r.id, s: JSON.stringify({ u: pj(r.v).u }), o: r.ord }); else out.push({ c: r.c, i: r.id, s: null, o: r.ord }); continue; }
      if (!PUBLIC_READ.has(b)) continue;
      if (r.v != null && (b === 'vacs' || b === 'goats')) {          // only what the public website shows
        const o = pj(r.v), show = o && (b === 'vacs' ? o.pub : (o.status === 'Available' && o.holder === 'Estate'));
        if (!show) { if (!full) out.push({ c: r.c, i: r.id, s: null, o: r.ord }); continue; }
      }
      out.push({ c: r.c, i: r.id, s: r.v, o: r.ord }); continue;
    }
    if (r.c === 'users') {                                         // PINs are never sent to other people
      if (r.v == null) { out.push({ c: r.c, i: r.id, s: null, o: r.ord }); continue; }
      const o = pj(r.v);
      if (EXTERNAL.has(ctx.role)) { if (o.u !== ctx.u) { out.push({ c: r.c, i: r.id, s: JSON.stringify({ u: o.u }), o: r.ord }); continue; } }
      else if (ctx.role !== 'admin' && o.u !== ctx.u) delete o.p;
      out.push({ c: r.c, i: r.id, s: JSON.stringify(o), o: r.ord }); continue;
    }
    if (EXTERNAL.has(ctx.role)) {
      if (EXT_PERSONAL.has(b)) {
        if (r.v != null) {
          if (!ids) ids = await identity(db, ctx);
          if (!ownedBy(pj(r.v), ids, r.v, ctx, b)) continue;
        }
      } else if (!EXT_SHARED.has(b)) continue;
      else if (b === 'vacs' && r.v != null) { const o = pj(r.v); if (!o || !o.pub) continue; }
    }
    out.push({ c: r.c, i: r.id, s: r.v, o: r.ord });
  }
  return out;
}
async function readState(db, ctx, since) {
  const rev = await currentRev(db);
  if (since != null && since > rev) since = null;                  // database was reset
  const q = since == null
    ? db.prepare('SELECT c,id,v,ord FROM rec WHERE v IS NOT NULL ORDER BY c, ord')
    : db.prepare('SELECT c,id,v,ord FROM rec WHERE rev>? ORDER BY rev, c, ord').bind(since);
  const rows = (await q.all()).results;
  return { rev, full: since == null, rows: await shape(db, rows, ctx, since == null) };
}

/* ---------------- login ---------------- */
async function login(request, env) {
  const db = env.DB, b = await request.json().catch(() => ({}));
  const u = String(b.u || '').trim(), p = String(b.p || '');
  const ip = request.headers.get('cf-connecting-ip') || 'x', fk = ip + '|' + u.toLowerCase();
  const f = await db.prepare('SELECT n,ts FROM fails WHERE k=?').bind(fk).first();
  if (f && f.n >= 8 && Date.now() - f.ts < 10 * 60e3) return json({ ok: false, msg: 'Too many wrong attempts. Wait 10 minutes and try again.' }, 429);
  const user = u ? await getUser(db, u) : null;
  if (!user || String(user.p) !== p) {
    await db.prepare('INSERT INTO fails(k,n,ts) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN ?>ts+600000 THEN 1 ELSE n+1 END, ts=?')
      .bind(fk, Date.now(), Date.now(), Date.now()).run();
    return json({ ok: false, msg: 'Wrong username or PIN' }, 401);
  }
  if (user.disabled) return json({ ok: false, msg: 'Account disabled' }, 403);
  await db.prepare('DELETE FROM fails WHERE k=?').bind(fk).run();
  const ctx = { u: user.u, role: user.role, user };
  return json({ ok: true, token: await makeToken(db, user.u, user.role), u: user.u, ...(await readState(db, ctx, null)) });
}

/* ---------------- writing ---------------- */
function authorize(ctx, op, ex, state) {
  const b = base(op.c), kind = op.k;
  const live = ex && ex.v != null;
  if (kind === 'add' && live) return ex.v === op.s ? 'noop' : 'conflict';
  if (op.c === '@seq') return 'ok';
  if (!ctx) {                                                       // ---- visitor
    if (kind === 'add' && ANON_ADD.has(b)) {
      if (b === 'users') { const o = pj(op.s); if (!o || o.role !== 'applicant' || op.id !== 'u:' + o.u) return 'deny'; }
      return 'ok';
    }
    if (kind === 'mod' && ANON_MOD.has(b)) return 'ok';
    return kind === 'add' ? 'skip' : 'skip';
  }
  if (b === 'users') {                                              // ---- accounts
    const o = op.s != null ? pj(op.s) : null, old = live ? pj(ex.v) : null;
    const target = old || o;
    if (!target) return 'skip';
    if (ctx.role === 'admin') return 'ok';
    if (ctx.role === 'owner') return (target.role === 'admin' || (o && o.role === 'admin')) ? 'deny' : 'ok';
    if (target.u === ctx.u) { if (kind === 'del') return 'deny'; return (o && o.role === ctx.role) ? 'ok' : 'deny'; }
    if (EXTERNAL.has(ctx.role)) return 'deny';
    // other staff (e.g. HR): may create / update normal accounts, never admin / owner
    if (SUPER.has(target.role) || (o && SUPER.has(o.role))) return 'deny';
    return 'ok';
  }
  if (b === 'audit' && ctx.role !== 'admin' && live) return 'deny';
  if (op.c === '@' && !SUPER.has(ctx.role)) return 'skip';          // one-time set-up flags are written by admin / owner only
  if (SUPER_ONLY.has(b) && !SUPER.has(ctx.role)) return kind === 'add' ? 'skip' : 'deny';
  if (EXTERNAL.has(ctx.role)) {
    if (EXT_NOWRITE.has(b)) return kind === 'add' ? 'skip' : 'deny';
    if (live && EXT_PERSONAL.has(b) && !state.owned(ex, b)) return 'deny';
    if (b === 'cands' && live) {
      const a = pj(ex.v) || {}, n = pj(op.s) || {};
      if (kind === 'del') return 'deny';
      for (const f of CAND_PROTECTED) if (JSON.stringify(a[f]) !== JSON.stringify(n[f])) return 'deny';
    }
  }
  return 'ok';
}

async function push(request, env, ctx) {
  const db = env.DB, body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.ops)) return json({ error: 'bad request' }, 400);
  const ops = body.ops.slice(0, 3000).filter(o => o && typeof o.c === 'string' && typeof o.id === 'string' && ['add', 'mod', 'del'].includes(o.k));
  const exist = new Map();
  for (let i = 0; i < ops.length; i += 40) {
    const part = ops.slice(i, i + 40);
    const res = await db.batch(part.map(o => db.prepare('SELECT c,id,v,ord FROM rec WHERE c=? AND id=?').bind(o.c, o.id)));
    res.forEach((r, j) => { const row = r.results[0]; if (row) exist.set(part[j].c + '\u0001' + part[j].id, row); });
  }
  let ids = null;
  const state = { owned: null };
  if (ctx && EXTERNAL.has(ctx.role)) { ids = await identity(db, ctx); state.owned = (row, b) => ownedBy(pj(row.v), ids, row.v, ctx, b); }
  const stmts = [], rejected = [], skipped = [], notes = [];
  const SQLREV = '(SELECT CAST(val AS INTEGER) FROM meta WHERE k=\'rev\')';
  for (const op of ops) {
    const ex = exist.get(op.c + '\u0001' + op.id);
    if (op.k !== 'del' && (typeof op.s !== 'string' || op.s.length > MAX_ROW)) { skipped.push({ c: op.c, i: op.id }); notes.push('A record was too large to save (limit about 1.8 MB) - use a smaller photo.'); continue; }
    let verdict = authorize(ctx, op, ex, state);
    if (verdict === 'ok' && !ctx && op.c === 'users') {
      const o = pj(op.s), nrc = o.nrc ? String(o.nrc) : null;
      const dup = await db.prepare("SELECT 1 FROM rec WHERE c='users' AND v IS NOT NULL AND (lower(id)=lower(?1) OR (?2 IS NOT NULL AND json_extract(v,'$.nrc')=?2 AND json_extract(v,'$.role')='applicant')) LIMIT 1").bind('u:' + o.u, nrc).first().catch(() => null);
      if (dup) { verdict = 'conflict'; notes.push('That username or NRC already has an account.'); }
    }
    if (verdict === 'noop') continue;
    if (verdict === 'conflict') { rejected.push({ c: op.c, i: op.id, s: ex ? ex.v : null, o: ex ? ex.ord : 0 }); if (!notes.length) notes.push('Someone else saved a record with the same number at the same moment - please repeat your last action.'); continue; }
    if (verdict === 'skip') { skipped.push({ c: op.c, i: op.id }); continue; }
    if (verdict === 'deny') { if (ctx) { rejected.push({ c: op.c, i: op.id, s: ex ? ex.v : null, o: ex ? ex.ord : 0 }); notes.push('You do not have permission to change that.'); } else skipped.push({ c: op.c, i: op.id }); continue; }
    if (op.k === 'del') { stmts.push(db.prepare(`UPDATE rec SET v=NULL, rev=${SQLREV} WHERE c=? AND id=? AND v IS NOT NULL`).bind(op.c, op.id)); continue; }
    if (op.c === '@seq') {
      stmts.push(db.prepare(`INSERT INTO rec(c,id,v,ord,rev) VALUES(?,?,?,0,${SQLREV}) ON CONFLICT(c,id) DO UPDATE SET v=CASE WHEN rec.v IS NULL OR CAST(excluded.v AS INTEGER)>CAST(rec.v AS INTEGER) THEN excluded.v ELSE rec.v END, rev=excluded.rev`).bind(op.c, op.id, op.s));
      continue;
    }
    let ord = '0', args = [op.c, op.id, op.s];
    if (op.c[0] !== '@') {
      if (op.after != null) { ord = `COALESCE((SELECT (a.ord+COALESCE((SELECT MIN(b.ord) FROM rec b WHERE b.c=a.c AND b.ord>a.ord),a.ord+2))/2.0 FROM rec a WHERE a.c=? AND a.id=?),(SELECT COALESCE(MAX(ord),0)+1 FROM rec WHERE c=?))`; args.push(op.c, String(op.after), op.c); }
      else { ord = '(SELECT COALESCE(MIN(ord),0)-1 FROM rec WHERE c=?)'; args.push(op.c); }
    }
    const upd = op.k === 'add' ? ' WHERE rec.v IS NULL' : '';
    stmts.push(db.prepare(`INSERT INTO rec(c,id,v,ord,rev) VALUES(?,?,?,${ord},${SQLREV}) ON CONFLICT(c,id) DO UPDATE SET v=excluded.v, rev=excluded.rev${upd}`).bind(...args));
  }
  const inc = db.prepare("UPDATE meta SET val=CAST(val AS INTEGER)+1 WHERE k='rev'");
  const shaped = [];
  for (const r of rejected) {
    const raw = r.s == null ? [] : await shape(db, [{ c: r.c, id: r.i, v: r.s, ord: r.o }], ctx);
    shaped.push({ c: r.c, i: r.i, s: raw.length ? raw[0].s : null, o: r.o });
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch([inc, ...stmts.slice(i, i + 40)]);
  return json({ ok: true, rev: await currentRev(db), rejected: shaped, skipped, notes: [...new Set(notes)] });
}

/* ---------------- files (PDF / images) ---------------- */
async function fileApi(request, env, ctx, url) {
  const db = env.DB, id = url.searchParams.get('id') || '';
  const isStaff = ctx && !EXTERNAL.has(ctx.role);
  if (request.method === 'GET' && !id) {                           // list (backup export)
    if (!isStaff) return json({ error: 'forbidden' }, 403);
    const rs = (await db.prepare('SELECT id,meta FROM files').all()).results;
    return json(rs.map(r => ({ id: r.id, ...(pj(r.meta) || {}) })));
  }
  if (!id || id.length > 120) return json({ error: 'bad id' }, 400);
  const f = await db.prepare('SELECT id,owner,size,n,meta FROM files WHERE id=?').bind(id).first();
  if (request.method === 'GET') {
    if (!f) return new Response('not found', { status: 404 });
    if (!isStaff && !(ctx && f.owner === ctx.u)) return json({ error: 'forbidden' }, 403);
    const cs = (await db.prepare('SELECT data FROM fchunks WHERE id=? ORDER BY i').bind(id).all()).results;
    const m = pj(f.meta) || {};
    return new Response(new Blob(cs.map(c => c.data), { type: m.type || 'application/octet-stream' }), { headers: { 'content-type': m.type || 'application/octet-stream', 'x-meta': encodeURIComponent(f.meta || '{}'), 'cache-control': 'no-store' } });
  }
  if (request.method === 'DELETE') {
    if (!f) return json({ ok: true });
    if (!isStaff && !(ctx && f.owner === ctx.u)) return json({ error: 'forbidden' }, 403);
    await db.batch([db.prepare('DELETE FROM fchunks WHERE id=?').bind(id), db.prepare('DELETE FROM files WHERE id=?').bind(id)]);
    return json({ ok: true });
  }
  if (request.method === 'POST') {
    if (f && !isStaff && !(ctx && f.owner === ctx.u)) return json({ error: 'forbidden' }, 403);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE) return json({ error: 'File too large (max 15 MB)' }, 413);
    const meta = pj(decodeURIComponent(request.headers.get('x-meta') || '%7B%7D')) || {};
    meta.size = buf.byteLength;
    const n = Math.max(1, Math.ceil(buf.byteLength / CHUNK));
    await db.batch([db.prepare('DELETE FROM fchunks WHERE id=?').bind(id)]);
    for (let i = 0; i < n; i += 4) {
      await db.batch([...Array(Math.min(4, n - i)).keys()].map(j => db.prepare('INSERT INTO fchunks(id,i,data) VALUES(?,?,?)').bind(id, i + j, buf.slice((i + j) * CHUNK, (i + j + 1) * CHUNK))));
    }
    await db.prepare('INSERT INTO files(id,owner,size,n,meta) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,size=excluded.size,n=excluded.n,meta=excluded.meta')
      .bind(id, f ? f.owner : (ctx ? ctx.u : ''), buf.byteLength, n, JSON.stringify(meta)).run();
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensure(env);
      const path = url.pathname.slice(5);
      if (path === 'login' && request.method === 'POST') return await login(request, env);
      const ctx = await auth(request, env);
      if (request.headers.get('authorization') && !ctx) return json({ error: 'session' }, 401);
      if (path === 'state') return json(await readState(env.DB, ctx, null));
      if (path === 'changes') { const s = url.searchParams.get('since'); return json(await readState(env.DB, ctx, s === null || s === '' ? null : +s)); }
      if (path === 'push' && request.method === 'POST') return await push(request, env, ctx);
      if (path === 'file') return await fileApi(request, env, ctx, url);
      if (path === 'ping') return json({ ok: true });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};
