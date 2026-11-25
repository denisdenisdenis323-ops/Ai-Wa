import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';

const {
  ANTHROPIC_API_KEY,
  WA_PHONE,
  MODEL = 'claude-sonnet-5-5',
  TRIGGER = '!ai',
  ALLOWED_GROUPS = '',
  SYSTEM_PROMPT = 'Kamu asisten AI di grup WhatsApp. Jawab singkat dan ramah.',
} = process.env;

if (!ANTHROPIC_API_KEY || !WA_PHONE) {
  console.error('Isi ANTHROPIC_API_KEY dan WA_PHONE di file .env');
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const allowed = ALLOWED_GROUPS.split(',').map((s) => s.trim()).filter(Boolean);
const trigger = TRIGGER.toLowerCase();

const history = new Map(); // groupJid -> [{role, content}]
const lastUse = new Map(); // sender -> timestamp
const MAX_TURNS = 10;
const COOLDOWN_MS = 4000;

const bareId = (jid = '') => jid.split('@')[0].split(':')[0];

function getText(m) {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  );
}

function isMentioned(m, sock) {
  const mentioned = m?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const mine = [bareId(sock.user?.id), bareId(sock.user?.lid)].filter(Boolean);
  return mentioned.some((j) => mine.includes(bareId(j)));
}

async function askClaude(groupJid, senderName, text) {
  const turns = history.get(groupJid) || [];
  turns.push({ role: 'user', content: `${senderName}: ${text}` });
  while (turns.length > MAX_TURNS) turns.shift();
  // pesan pertama harus dari user
  while (turns.length && turns[0].role !== 'user') turns.shift();

  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: turns,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
  });
  const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  turns.push({ role: 'assistant', content: reply });
  history.set(groupJid, turns);
  return reply || '...';
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  // Login pakai kode pairing (tanpa scan QR)
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(WA_PHONE);
      console.log(`\nKode pairing: ${code}`);
      console.log('Di HP: WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon\n');
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('Terhubung. Bot aktif di grup.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logout. Hapus folder ./auth lalu jalankan ulang.');
      } else {
        console.log('Koneksi putus, menyambung ulang...');
        start();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us') || !msg.message) continue;
        if (allowed.length && !allowed.includes(jid)) continue;

        const text = getText(msg.message).trim();
        if (!text) continue;

        const hasTrigger = text.toLowerCase().startsWith(trigger);
        const mentioned = isMentioned(msg.message, sock);
        if (!hasTrigger && !mentioned) continue;

        // Hindari loop: abaikan balasan bot sendiri (diberi penanda di bawah)
        if (msg.key.fromMe && msg.key.id?.startsWith('AIBOT')) continue;

        const sender = msg.key.participant || msg.key.remoteJid;
        const now = Date.now();
        if (now - (lastUse.get(sender) || 0) < COOLDOWN_MS) continue;
        lastUse.set(sender, now);

        let prompt = hasTrigger ? text.slice(trigger.length).trim() : text;
        prompt = prompt.replace(/@\d+/g, '').trim();
        if (!prompt) {
          await sock.sendMessage(jid, { text: `Tanya apa? Contoh: ${TRIGGER} apa itu inflasi?` }, { quoted: msg });
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid);
        const name = msg.pushName || bareId(sender);
        const reply = await askClaude(jid, name, prompt);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg, messageId: 'AIBOT' + Date.now() });
        await sock.sendPresenceUpdate('paused', jid);
      } catch (err) {
        console.error('Error:', err.message);
      }
    }
  });
}

start();
