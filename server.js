const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { DATABASE_URL, JWT_SECRET, BREVO_API_KEY, BREVO_SENDER, CRON_SECRET,
  ADMIN_USERNAME, FRONTEND_ORIGIN, TZ_NAME = 'Asia/Kolkata', PORT = 3000 } = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Set DATABASE_URL and JWT_SECRET first.'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});
const q = (s, p) => pool.query(s, p);
const REV = [1, 3, 7, 15, 25, 30];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ_NAME });
const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const flat = d => (Array.isArray(d) ? d : []).flatMap(c => (c.secs || []).flatMap(s => (s.topics || []).map(t => ({ c: c.name, s: s.name, t }))));

async function mail(to, subject, html) {
  if (!BREVO_API_KEY || !BREVO_SENDER) throw new Error('Email is not configured on the server yet.');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ sender: { name: 'Exam Scheduler', email: BREVO_SENDER }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!r.ok) throw new Error('Brevo rejected the email: ' + (await r.text()));
}

// Sends today's learn + revise list. Returns false when there is nothing to send (unless force).
async function digest(u, force) {
  const T = today(), all = flat(u.data);
  const due = all.filter(x => !x.t.done && x.t.date && x.t.date <= T);
  const rev = all.filter(x => x.t.done && x.t.doneDate).flatMap(x =>
    REV.filter(n => !(x.t.rev || []).includes(n) && T >= add(x.t.doneDate, n)).slice(0, 1).map(n => ({ ...x, n })));
  if (!due.length && !rev.length && !force) return false;
  const ul = a => a.length ? '<ul>' + a.join('') + '</ul>' : '<p>Nothing.</p>';
  await mail(u.email, `Study plan ${T}: ${due.length} to learn, ${rev.length} to revise`,
    `<h2>Hi ${esc(u.username)}, hard work today is freedom tomorrow.</h2>
     <h3>Learn today</h3>${ul(due.map(x => `<li>${esc(x.t.name)} (${esc(x.c)} &rsaquo; ${esc(x.s)})</li>`))}
     <h3>Revise today</h3>${ul(rev.map(x => `<li>${esc(x.t.name)}, day ${x.n} revision</li>`))}`);
  return true;
}

// Emails the revision dates when a topic is newly marked as learned.
async function learnedMail(u, oldData, newData) {
  const was = new Set(flat(oldData).filter(x => x.t.done).map(x => x.t.id));
  const fresh = flat(newData).filter(x => x.t.done && !was.has(x.t.id)).slice(0, 5);
  for (const x of fresh) {
    const dates = REV.map(n => `Day ${n}: ${add(x.t.doneDate || today(), n)}`);
    await mail(u.email, `Learned: ${x.t.name}. Your revision dates`,
      `<p>Well done on finishing <b>${esc(x.t.name)}</b> (${esc(x.c)}).</p><p>Revise on:</p><ul>${dates.map(d => `<li>${d}</li>`).join('')}</ul>`);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (FRONTEND_ORIGIN) {
    res.set({ 'Access-Control-Allow-Origin': FRONTEND_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
const h = f => (req, res, next) => f(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'Server error. Try again.' }); });
const need = (req, res, next) => {
  try { req.u = jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Please log in again.' }); }
};
const adminOnly = h(async (req, res, next) => {
  const r = await q('select is_admin from users where id=$1', [req.u.id]);
  r.rows[0]?.is_admin ? next() : res.status(403).json({ error: 'Admins only.' });
});
const token = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/register', limiter, h(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), email = String(req.body.email || '').trim(), password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or _.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password needs 8+ characters.' });
  if ((await q('select 1 from users where username=$1', [username])).rowCount) return res.status(409).json({ error: 'That username is taken.' });
  const first = Number((await q('select count(*) from users')).rows[0].count) === 0;
  const r = await q('insert into users(username,email,pass_hash,is_admin) values($1,$2,$3,$4) returning id',
    [username, email, await bcrypt.hash(password, 10), first || username === (ADMIN_USERNAME || '').toLowerCase()]);
  res.json({ token: token(r.rows[0]) });
}));

app.post('/api/login', limiter, h(async (req, res) => {
  const r = await q('select id,pass_hash from users where username=$1', [String(req.body.username || '').trim().toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.pass_hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: token(u) });
}));

app.get('/api/data', need, h(async (req, res) => {
  const r = await q('select u.username,u.is_admin,d.data from users u left join user_data d on d.user_id=u.id where u.id=$1', [req.u.id]);
  if (!r.rows[0]) return res.status(401).json({ error: 'Please log in again.' });
  res.json({ username: r.rows[0].username, admin: r.rows[0].is_admin, data: r.rows[0].data });
}));

app.put('/api/data', need, h(async (req, res) => {
  if (!Array.isArray(req.body.data)) return res.status(400).json({ error: 'Invalid data.' });
  const old = (await q('select u.username,u.email,d.data from users u left join user_data d on d.user_id=u.id where u.id=$1', [req.u.id])).rows[0];
  await q('insert into user_data(user_id,data,updated_at) values($1,$2,now()) on conflict(user_id) do update set data=$2,updated_at=now()', [req.u.id, JSON.stringify(req.body.data)]);
  if (old && old.data) learnedMail(old, old.data, req.body.data).catch(e => console.error('learnedMail', e.message));
  res.json({ ok: true });
}));

app.post('/api/remind-now', need, h(async (req, res) => {
  const r = await q('select u.username,u.email,d.data from users u left join user_data d on d.user_id=u.id where u.id=$1', [req.u.id]);
  try { await digest(r.rows[0], true); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
}));

app.get('/api/admin/users', need, adminOnly, h(async (req, res) => {
  const r = await q('select u.id,u.username,u.email,u.is_admin,d.data from users u left join user_data d on d.user_id=u.id order by u.id');
  res.json(r.rows.map(u => { const l = flat(u.data); return { id: u.id, username: u.username, email: u.email, is_admin: u.is_admin, total: l.length, learned: l.filter(x => x.t.done).length }; }));
}));

app.delete('/api/admin/users/:id', need, adminOnly, h(async (req, res) => {
  if (Number(req.params.id) === req.u.id) return res.status(400).json({ error: 'You cannot delete yourself.' });
  await q('delete from users where id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// Call once a day from an external scheduler (see README). Also wakes a sleeping free instance.
app.get('/api/cron/daily', h(async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const T = today();
  const { rows } = await q("select u.id,u.username,u.email,d.data from users u join user_data d on d.user_id=u.id where coalesce(u.last_digest,'')<>$1", [T]);
  let sent = 0;
  for (const u of rows) {
    try { if (await digest(u)) sent++; await q('update users set last_digest=$1 where id=$2', [T, u.id]); }
    catch (e) { console.error('digest', u.username, e.message); }
  }
  res.json({ date: T, sent });
}));

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await q(`create table if not exists users(
    id serial primary key, username text unique not null, email text not null,
    pass_hash text not null, is_admin boolean not null default false, last_digest text, created_at timestamptz default now())`);
  await q(`create table if not exists user_data(
    user_id int primary key references users(id) on delete cascade, data jsonb, updated_at timestamptz default now())`);
  app.listen(PORT, () => console.log('Running on port ' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
