const express = require('express');
const { randomUUID } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const LIMITS = { free: 10, pro: Infinity };

if (!ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// ── JSON Storage ────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// users: { byKey: { apiKey: UserRecord }, byEmail: { email: apiKey } }
let users = loadJSON(USERS_FILE, { byKey: {}, byEmail: {} });
// usage: { "userId:YYYY-MM-DD": count }
let usage = loadJSON(USAGE_FILE, {});

function persistUsers() { saveJSON(USERS_FILE, users); }
function persistUsage() { saveJSON(USAGE_FILE, usage); }

// ── Auth ────────────────────────────────────────────────────────────
function generateApiKey() {
  const bytes = require('crypto').randomBytes(32);
  return 'mp_' + bytes.toString('hex');
}

function registerUser(email) {
  const existing = users.byEmail[email];
  if (existing) {
    const user = users.byKey[existing];
    if (user) return { apiKey: existing, user };
  }
  const apiKey = generateApiKey();
  const user = { userId: uuidv4(), email, plan: 'free', createdAt: new Date().toISOString() };
  users.byKey[apiKey] = user;
  users.byEmail[email] = apiKey;
  persistUsers();
  return { apiKey, user };
}

function validateApiKey(apiKey) {
  if (apiKey.includes('@')) {
    const storedKey = users.byEmail[apiKey];
    if (!storedKey) return null;
    return users.byKey[storedKey] || null;
  }
  return users.byKey[apiKey] || null;
}

// ── Rate Limiting ───────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function endOfDayUnix() {
  const now = new Date();
  const eod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.floor(eod.getTime() / 1000);
}

function checkAndIncrement(user) {
  const key = `${user.userId}:${todayStr()}`;
  const limit = LIMITS[user.plan];
  const resetAt = endOfDayUnix();
  const used = usage[key] || 0;
  const allowed = used < limit;
  const remaining = Math.max(0, limit === Infinity ? 9999 : limit - used);
  const headers = {
    'X-RateLimit-Limit': limit === Infinity ? 'unlimited' : String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetAt),
  };
  if (allowed) {
    usage[key] = used + 1;
    persistUsage();
  }
  return { allowed, used: allowed ? used + 1 : used, limit: limit === Infinity ? -1 : limit, remaining: allowed ? remaining - 1 : remaining, resetAt, headers };
}

function getUsage(user) {
  const key = `${user.userId}:${todayStr()}`;
  const used = usage[key] || 0;
  const limit = LIMITS[user.plan];
  return { plan: user.plan, used_today: used, limit: limit === Infinity ? -1 : limit, remaining: limit === Infinity ? -1 : Math.max(0, limit - used), resets_at: endOfDayUnix() };
}

// ── AI Functions ────────────────────────────────────────────────────
function buildClient() { return new Anthropic({ apiKey: ANTHROPIC_API_KEY }); }

async function generateDraft(req) {
  const client = buildClient();
  const tone = req.settings?.tone || 'professional';
  const lang = req.settings?.language || 'en';
  const threadContext = req.previousMessages?.length
    ? `\n\nPrevious messages in thread:\n${req.previousMessages.map(m => `From ${m.from}:\n${m.text}`).join('\n---\n')}`
    : '';
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 1024,
    system: `You are MailPilot, an expert email ghostwriter. You write emails that sound natural, human, and contextually appropriate — never robotic or templated.\n\nRules:\n- Match the ${tone} tone precisely\n- Write in ${lang}\n- Use the thread context to craft a relevant, on-point reply\n- Keep it concise — busy professionals don't read novels\n- Include a greeting and sign-off appropriate to the relationship\n- Never include placeholder brackets like [Your Name] — write a complete, ready-to-send email\n- If replying to a thread, reference specifics from prior messages to show you read them\n- Output ONLY the email body text, nothing else`,
    messages: [{ role: 'user', content: `Subject: ${req.subject}\nRecipients: ${(req.recipients || []).join(', ') || 'Not specified'}${threadContext}\n\n${req.prompt || 'Write the email.'}` }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return { draft: text.trim(), model: MODEL, tokens_used: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0) };
}

const TONE_INSTRUCTIONS = {
  professional: 'Formal, polished, business-appropriate. Clear structure, proper grammar, respectful tone.',
  friendly: 'Warm, approachable, conversational. Like writing to a colleague you like. Use contractions naturally.',
  direct: 'Cut the fluff. State what you need clearly. Short sentences. No unnecessary pleasantries.',
  concise: 'Minimize word count while preserving all meaning. Every word must earn its place.',
};

async function rewriteText(req) {
  const client = buildClient();
  const lang = req.settings?.language || 'en';
  const toneGuide = TONE_INSTRUCTIONS[req.tone] || TONE_INSTRUCTIONS.professional;
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 1024,
    system: `You are MailPilot, an expert email editor. Rewrite the given text to match the requested tone while preserving the original intent and all key information.\n\nTone: ${req.tone}\n${toneGuide}\n\nRules:\n- Write in ${lang}\n- Preserve all factual content — change style, not substance\n- Fix grammar and spelling issues in the original\n- Never add information that wasn't in the original\n- Output ONLY the rewritten text, nothing else`,
    messages: [{ role: 'user', content: req.subject ? `Subject: ${req.subject}\n\nRewrite this:\n${req.text}` : `Rewrite this:\n${req.text}` }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return { rewritten: text.trim(), model: MODEL, tokens_used: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0) };
}

async function summarizeThread(req) {
  const client = buildClient();
  const lang = req.settings?.language || 'en';
  const thread = req.messages.map(m => `From ${m.from}:\n${m.text}`).join('\n---\n');
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 512,
    system: `You are MailPilot, an expert email summarizer. Distill email threads into clear, actionable summaries.\n\nRules:\n- Write in ${lang}\n- Use bullet points for key facts, decisions, and action items\n- Identify who said what when it matters\n- Highlight any deadlines or commitments\n- Put the most important takeaway first\n- Be concise — the whole point is saving time\n- Output ONLY the summary, nothing else`,
    messages: [{ role: 'user', content: `Subject: ${req.subject}\n\nThread:\n${thread}\n\nSummarize this thread.` }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return { summary: text.trim(), model: MODEL, tokens_used: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0) };
}

// ── Express App ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.header('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'mailpilot-api' }));

// Register
app.post('/api/auth/register', (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required', code: 'INVALID_REQUEST' });
  const result = registerUser(email);
  res.json({ api_key: result.apiKey, plan: result.user.plan });
});

// Auth middleware for all /api/* except register
function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header', code: 'UNAUTHORIZED' });
  const user = validateApiKey(apiKey);
  if (!user) return res.status(401).json({ error: 'Invalid API key', code: 'UNAUTHORIZED' });
  req.user = user;
  next();
}

// Usage
app.get('/api/usage', authMiddleware, (req, res) => {
  res.json(getUsage(req.user));
});

// Rate limit middleware for AI endpoints
function rateLimitMiddleware(req, res, next) {
  const result = checkAndIncrement(req.user);
  if (!result.allowed) {
    Object.entries(result.headers).forEach(([k, v]) => res.header(k, v));
    return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', retry_after: 3600 });
  }
  req.rateHeaders = result.headers;
  next();
}

// Generate
app.post('/api/generate', authMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    if (!req.body.subject) return res.status(400).json({ error: 'subject is required', code: 'INVALID_REQUEST' });
    const result = await generateDraft(req.body);
    Object.entries(req.rateHeaders).forEach(([k, v]) => res.header(k, v));
    res.json(result);
  } catch (e) { console.error('generate error:', e); res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); }
});

// Rewrite
app.post('/api/rewrite', authMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    if (!req.body.text || !req.body.tone) return res.status(400).json({ error: 'text and tone required', code: 'INVALID_REQUEST' });
    const result = await rewriteText(req.body);
    Object.entries(req.rateHeaders).forEach(([k, v]) => res.header(k, v));
    res.json(result);
  } catch (e) { console.error('rewrite error:', e); res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); }
});

// Summarize
app.post('/api/summarize', authMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    if (!req.body.messages?.length) return res.status(400).json({ error: 'messages array required', code: 'INVALID_REQUEST' });
    const result = await summarizeThread(req.body);
    Object.entries(req.rateHeaders).forEach(([k, v]) => res.header(k, v));
    res.json(result);
  } catch (e) { console.error('summarize error:', e); res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }); }
});

app.listen(PORT, () => console.log(`MailPilot API running on port ${PORT}`));
