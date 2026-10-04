require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  Events,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ENV / SABİTLER
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DEFAULT_PRICE = 10;

// Botun ihtiyaç duyduğu izinler (OAuth2 "bot ekle" linki için)
const BOT_INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.ManageWebhooks,
]).bitfield.toString();

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error('HATA: .env dosyasında TOKEN, CLIENT_ID ve OWNER_ID tanımlı olmalı.');
  process.exit(1);
}

// Beklenmeyen/yakalanmamış hatalar botu tamamen kapatmasın diye (Node.js
// varsayılan olarak yakalanmamış promise reddinde process'i sonlandırır).
// Hata loglanır ama bot arka planda çalışmaya devam eder.
process.on('unhandledRejection', (reason) => {
  console.error('Yakalanamayan promise hatası (bot çalışmaya devam ediyor):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata (bot çalışmaya devam ediyor):', err);
});

// VERİTABANI (SQLite3 - better-sqlite3)
const db = new Database(path.join(__dirname, 'bot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS server_backups (
  guild_id TEXT PRIMARY KEY,
  backup_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  guild_name TEXT,
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quarantine_status (
  guild_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quarantine_locks (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  original_state TEXT NOT NULL, -- 'inherit' | 'allow' | 'deny'
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS known_guilds (
  guild_id TEXT PRIMARY KEY
);
`);

// DB YARDIMCI FONKSİYONLARI
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (err) {
    console.error('getSetting hatası:', err);
    return fallback;
  }
}

function setSetting(key, value) {
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  } catch (err) {
    console.error('setSetting hatası:', err);
  }
}

function getPrice() {
  const v = getSetting('ekle_fiyat', String(DEFAULT_PRICE));
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : DEFAULT_PRICE;
}

// Bot sahibine (owner) sıcak/samimi hitap eder ("Patronum, ..."), diğer
// kullanıcılara nötr/mesafeli kalır (ekstra samimiyet eklenmez).
function addressPrefix(userId) {
  return userId === OWNER_ID ? 'Patronum, ' : '';
}

// Yapay zeka sağlayıcısı: openrouter | gemini | openai | claude
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';
const OPENROUTER_FALLBACK_MODELS = ['openrouter/auto', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct:free'];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-haiku-latest';

const BOT_TRIGGER_NAME = (process.env.BOT_TRIGGER_NAME || '').toLowerCase();

// Kanal başına son 50 mesajı (kullanıcı+bot) RAM'de tutar; bot yeniden
// başlayınca sıfırlanır, kalıcı değildir.
const CHAT_HISTORY_LIMIT = 50;
const chatHistories = new Map(); // channelId -> [{role, content}, ...]

function getHistory(channelId) {
  return chatHistories.get(channelId) || [];
}

function pushHistory(channelId, role, content) {
  const history = chatHistories.get(channelId) || [];
  history.push({ role, content });
  while (history.length > CHAT_HISTORY_LIMIT) history.shift();
  chatHistories.set(channelId, history);
}

async function callOpenRouterModel(model, systemPrompt, history, userText) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userText }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter hatası (${response.status}) [${model}]: ${errText}`);
  }
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error(`OpenRouter boş yanıt döndürdü [${model}].`);
  return reply;
}

async function callOpenAI(systemPrompt, history, userText) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY tanımlı değil.');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userText }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI hatası (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('OpenAI boş yanıt döndürdü.');
  return reply;
}

async function callGemini(systemPrompt, history, userText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY tanımlı değil.');
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userText }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini hatası (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error('Gemini boş yanıt döndürdü.');
  return reply;
}

async function callClaude(systemPrompt, history, userText) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY tanımlı değil.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: userText }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude hatası (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const reply = data?.content?.[0]?.text;
  if (!reply) throw new Error('Claude boş yanıt döndürdü.');
  return reply;
}

async function askAI(channelId, userText, isOwner) {
  const systemPrompt = isOwner
    ? 'Sen bu Discord sunucu güvenlik/moderasyon botusun. Konuştuğun kişi senin PATRONUN yani bot sahibi. Ona sıcak, samimi, esprili ve içten davran, zaman zaman "Patronum" diye hitap et. Türkçe, doğal ve bol sohbet edecek şekilde cevap ver. Önceki mesajları hatırlayıp bağlamlı cevap ver.'
    : 'Sen bu Discord sunucu güvenlik/moderasyon botusun. Kullanıcılara kibar ama mesafeli ve profesyonel bir tonla cevap ver; aşırı samimi, aşırı şakacı olma. Türkçe cevap ver, kısa ve öz ol. Önceki mesajları hatırlayıp bağlamlı cevap ver.';

  const history = getHistory(channelId);
  let reply;

  if (AI_PROVIDER === 'gemini') {
    reply = await callGemini(systemPrompt, history, userText);
  } else if (AI_PROVIDER === 'openai') {
    reply = await callOpenAI(systemPrompt, history, userText);
  } else if (AI_PROVIDER === 'claude') {
    reply = await callClaude(systemPrompt, history, userText);
  } else {
    if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY tanımlı değil.');
    const modelsToTry = [OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS.filter((m) => m !== OPENROUTER_MODEL)];
    let lastError;
    for (const model of modelsToTry) {
      try {
        reply = await callOpenRouterModel(model, systemPrompt, history, userText);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`OpenRouter modeli başarısız (${model}), sıradaki denenecek:`, err.message || err);
      }
    }
    if (lastError) throw lastError;
  }

  pushHistory(channelId, 'user', userText);
  pushHistory(channelId, 'assistant', reply);
  return reply;
}

// Discord mesaj limiti (2000 karakter) aşılırsa parçalara böler
function chunkText(text, size = 1900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, size));
    remaining = remaining.slice(size);
  }
  return chunks;
}

function ensureUser(userId) {
  try {
    db.prepare(
      `INSERT INTO users (user_id, credits) VALUES (?, 0)
       ON CONFLICT(user_id) DO NOTHING`
    ).run(userId);
  } catch (err) {
    console.error('ensureUser hatası:', err);
  }
}

function getCredits(userId) {
  try {
    ensureUser(userId);
    const row = db.prepare('SELECT credits FROM users WHERE user_id = ?').get(userId);
    return row ? row.credits : 0;
  } catch (err) {
    console.error('getCredits hatası:', err);
    return 0;
  }
}

function addCredits(userId, amount) {
  try {
    ensureUser(userId);
    db.prepare('UPDATE users SET credits = credits + ? WHERE user_id = ?').run(amount, userId);
    return getCredits(userId);
  } catch (err) {
    console.error('addCredits hatası:', err);
    return getCredits(userId);
  }
}

function deductCredits(userId, amount) {
  try {
    ensureUser(userId);
    db.prepare('UPDATE users SET credits = credits - ? WHERE user_id = ?').run(amount, userId);
    return getCredits(userId);
  } catch (err) {
    console.error('deductCredits hatası:', err);
    return getCredits(userId);
  }
}

// DISCORD CLIENT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// SLASH KOMUT TANIMLARI
const commands = [
  new SlashCommandBuilder()
    .setName('ekle')
    .setDescription('Botu kendi sunucunuza eklemek için ödeme yapın ve yetkilendirme linki alın.')
    .addStringOption((opt) =>
      opt
        .setName('sunucu_davet_linki')
        .setDescription('Sunucunuzun Discord davet linki (örn: discord.gg/xxxxxx)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('kredi')
    .setDescription('Kalan krediinizi gösterir.'),

  new SlashCommandBuilder()
    .setName('fiyat-ayarla')
    .setDescription('[Sadece bot sahibi] /ekle komutunun fiyatını değiştirir.')
    .addIntegerOption((opt) =>
      opt.setName('fiyat').setDescription('Yeni fiyat (kredi)').setRequired(true).setMinValue(0)
    ),

  new SlashCommandBuilder()
    .setName('kredi-ver')
    .setDescription('[Sadece bot sahibi] Bir kullanıcıya kredi ekler.')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Kredi verilecek kullanıcı').setRequired(true))
    .addIntegerOption((opt) => opt.setName('miktar').setDescription('Eklenecek kredi miktarı').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('kredisil')
    .setDescription('[Sadece bot sahibi] Bir kullanıcının kredisini siler/düşer.')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Kredisi silinecek kullanıcı').setRequired(true))
    .addIntegerOption((opt) => opt.setName('miktar').setDescription('Silinecek kredi miktarı').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('sunucular')
    .setDescription('Botun içinde bulunduğu tüm sunucuları listeler.'),

  new SlashCommandBuilder()
    .setName('cik')
    .setDescription('[Sadece bot sahibi] Botu belirtilen sunucudan çıkarır.')
    .addStringOption((opt) => opt.setName('sunucu_id').setDescription('Çıkılacak sunucunun ID\'si').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kurtar')
    .setDescription('Sunucuyu en son kayıtlı yedekten geri yükler (sunucu sahibi).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('karantina')
    .setDescription('Akıllı sunucu karantinasını açar/kapatır.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('durum')
        .setDescription('ac veya kapat')
        .setRequired(true)
        .addChoices({ name: 'aç', value: 'ac' }, { name: 'kapat', value: 'kapat' })
    ),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bir kullanıcıyı yasaklar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Yasaklanacak kullanıcı').setRequired(true))
    .addStringOption((opt) => opt.setName('sebep').setDescription('Sebep').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Bir kullanıcının yasağını kaldırır.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((opt) => opt.setName('kullanici_id').setDescription('Kullanıcı ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Bir kullanıcıyı susturur (timeout).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Susturulacak kullanıcı').setRequired(true))
    .addIntegerOption((opt) => opt.setName('dakika').setDescription('Süre (dakika)').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((opt) => opt.setName('sebep').setDescription('Sebep').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Bir kullanıcının susturmasını kaldırır.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Kullanıcı').setRequired(true)),

  new SlashCommandBuilder()
    .setName('sohbet')
    .setDescription('Kanalı kilitler/açar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) => sub.setName('kilitle').setDescription('Bu kanalı kilitler'))
    .addSubcommand((sub) => sub.setName('ac').setDescription('Bu kanalın kilidini açar')),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const testGuildId = process.env.TEST_GUILD_ID;
    if (testGuildId) {
      // Guild'e özel kayıt anında yansır (test için idealdir)
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, testGuildId), { body: commands });
      console.log(`Slash komutları TEST_GUILD_ID (${testGuildId}) sunucusuna ANINDA kaydedildi.`);
    } else {
      // Global kayıt tüm sunucularda çalışır ama yayılması ilk seferde ~1 saate kadar sürebilir
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Slash komutları GLOBAL olarak kaydedildi (ilk yayılma ~1 saat sürebilir).');
    }
  } catch (err) {
    console.error('Komut kaydı hatası:', err);
  }
}

// YARDIMCI: Sunucu yedeği alma (roller + kanallar -> JSON)
async function backupGuild(guild) {
  try {
    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id) // @everyone hariç
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        oldId: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        position: r.position,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
      }));

    const channels = guild.channels.cache
      .sort((a, b) => a.position - b.position)
      .map((ch) => ({
        oldId: ch.id,
        name: ch.name,
        type: ch.type,
        parentOldId: ch.parentId,
        position: ch.position,
        topic: ch.topic || null,
        nsfw: ch.nsfw || false,
        bitrate: ch.bitrate || undefined,
        userLimit: ch.userLimit || undefined,
        permissionOverwrites: ch.permissionOverwrites.cache.map((po) => ({
          id: po.id,
          type: po.type, // 0 = role, 1 = member
          allow: po.allow.bitfield.toString(),
          deny: po.deny.bitfield.toString(),
        })),
      }));

    const backupJson = JSON.stringify({ roles, channels, backedUpAt: Date.now() });

    db.prepare(
      `INSERT INTO server_backups (guild_id, backup_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET backup_json = excluded.backup_json, created_at = excluded.created_at`
    ).run(guild.id, backupJson, Date.now());

    console.log(`[YEDEK] ${guild.name} (${guild.id}) yedeklendi.`);
  } catch (err) {
    console.error('backupGuild hatası:', err);
  }
}

// Sunucu listesi anlık görüntüsü (guilds.json) - Termux menüsü bot kapalıyken
// bile son bilinen sunucu listesini gösterebilsin diye diske yazılır.
function saveGuildsSnapshot() {
  try {
    const snapshot = [...client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount ?? null,
    }));
    fs.writeFileSync(path.join(__dirname, 'guilds.json'), JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error('saveGuildsSnapshot hatası:', err);
  }
}

// guildCreate'in gerçek zamanlı tetiklenmesi VE bot kapalıyken eklenip ready
// anında fark edilen sunucular için ortak işleyici.
async function processGuildJoin(guild) {
  await backupGuild(guild);

  const pending = db
    .prepare(`SELECT * FROM pending_invites WHERE guild_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
    .get(guild.id);

  if (pending) {
    deductCredits(pending.user_id, pending.cost);
    db.prepare(`UPDATE pending_invites SET status = 'completed' WHERE id = ?`).run(pending.id);
    try {
      const user = await client.users.fetch(pending.user_id);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Bot sunucunuza başarıyla eklendi!')
        .setDescription(
          `**${guild.name}** sunucusuna giriş yapıldı ve ${pending.cost} kredi hesabınızdan düşüldü.\nGüncel krediniz: **${getCredits(pending.user_id)}**`
        );
      await user.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      console.error('Bekleyen istek DM bildirim hatası:', err);
    }
    db.prepare('INSERT OR IGNORE INTO known_guilds (guild_id) VALUES (?)').run(guild.id);
    saveGuildsSnapshot();
    return;
  }

  // Ödeme akışı dışında eklenmiş: botu bizzat owner eklediyse (test) izin ver, aksi halde çık.
  let addedByOwner = false;
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: 28, limit: 5 }); // AuditLogEvent.BotAdd
    const entry = auditLogs.entries.find((e) => e.targetId === client.user.id);
    if (entry && entry.executorId === OWNER_ID) addedByOwner = true;
  } catch (err) {
    console.error('Audit log (BotAdd) okuma hatası:', err);
  }

  if (addedByOwner) {
    db.prepare('INSERT OR IGNORE INTO known_guilds (guild_id) VALUES (?)').run(guild.id);
    saveGuildsSnapshot();
    return;
  }

  console.warn(`[İZİNSİZ GİRİŞ] "${guild.name}" (${guild.id}) /ekle akışı dışında eklendi, çıkılıyor...`);

  try {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const warnEmbed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('⛔ Yetkisiz ekleme')
        .setDescription(
          `Bu bot yalnızca resmi \`/ekle\` komutu üzerinden satın alınarak sunucuya eklenebilir.\n` +
            `Bu sunucuya bu şekilde eklenmediği için otomatik olarak ayrılıyor.`
        );
      await owner.send({ embeds: [warnEmbed] }).catch(() => {});
    }
  } catch (err) {
    console.error('İzinsiz giriş DM uyarı hatası:', err);
  }

  try {
    const botOwner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (botOwner) {
      const alertEmbed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('🚨 İzinsiz sunucu ekleme denemesi')
        .setDescription(
          `Patronum, bir sorun var:\n\n**${guild.name}**\n\`${guild.id}\`  •  👥 ${guild.memberCount ?? '?'}\n\n` +
            `Bu sunucu \`/ekle\` akışını kullanmadan bota erişim verdi. Bot otomatik olarak ayrıldı.`
        );
      await botOwner.send({ embeds: [alertEmbed] }).catch(() => {});
    }
  } catch (err) {
    console.error('İzinsiz giriş bot sahibi bildirim hatası:', err);
  }

  await guild.leave().catch((err) => console.error('İzinsiz sunucudan çıkma hatası:', err));
  db.prepare('DELETE FROM server_backups WHERE guild_id = ?').run(guild.id);
  db.prepare('DELETE FROM known_guilds WHERE guild_id = ?').run(guild.id);
  saveGuildsSnapshot();
}

client.on(Events.GuildCreate, async (guild) => {
  try {
    await processGuildJoin(guild);
  } catch (err) {
    console.error('GuildCreate handler hatası:', err);
  }
});

// Bot kapalıyken (çevrimdışıyken) biri botu bir sunucuya eklerse, o katılım
// guildCreate olarak tetiklenmez — bot tekrar bağlanınca ready anında bilinen
// sunucu listesiyle karşılaştırıp kaçırılan katılımları burada yakalıyoruz.
async function catchUpMissedGuilds() {
  try {
    const known = new Set(db.prepare('SELECT guild_id FROM known_guilds').all().map((r) => r.guild_id));
    const current = [...client.guilds.cache.values()];
    const missed = current.filter((g) => !known.has(g.id));

    if (missed.length === 0) return;

    console.log(`[AÇILIŞ TARAMASI] Bot kapalıyken eklenmiş ${missed.length} sunucu bulundu, işleniyor...`);
    for (const guild of missed) {
      await processGuildJoin(guild).catch((err) => console.error('catchUpMissedGuilds işleme hatası:', err));
    }
  } catch (err) {
    console.error('catchUpMissedGuilds hatası:', err);
  }
}

// Bot bir sunucudan çıkarılırsa (kick edilirse veya /cik ile çıkılırsa) listeyi güncelle
client.on(Events.GuildDelete, (guild) => {
  db.prepare('DELETE FROM known_guilds WHERE guild_id = ?').run(guild.id);
  saveGuildsSnapshot();
});

// SERBEST SOHBET: Bot etiketlenince VEYA mesajda adı geçince yapay zeka
// ile bol bol sohbet eder.
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return; // botlara ve kendine cevap verme

    const mentioned = client.user && message.mentions.has(client.user);
    const triggerName = (BOT_TRIGGER_NAME || client.user.username || '').toLowerCase();
    const containsName = triggerName.length > 0 && message.content.toLowerCase().includes(triggerName);

    if (!mentioned && !containsName) return;
    const providerConfigured =
      (AI_PROVIDER === 'gemini' && GEMINI_API_KEY) ||
      (AI_PROVIDER === 'openai' && OPENAI_API_KEY) ||
      (AI_PROVIDER === 'claude' && ANTHROPIC_API_KEY) ||
      (AI_PROVIDER === 'openrouter' && OPENROUTER_API_KEY);
    if (!providerConfigured) return; // yapılandırılmamışsa sessizce yok say

    // Etiket tag'lerini (<@id>) temizleyip düz metni çıkar
    const cleaned = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!cleaned) return;

    await message.channel.sendTyping().catch(() => {});

    const isOwner = message.author.id === OWNER_ID;
    const reply = await askAI(message.channel.id, cleaned, isOwner);
    const finalText = isOwner ? `${reply}` : reply; // owner tonu zaten sistem promptunda ayarlı

    const chunks = chunkText(finalText);
    for (const chunk of chunks) {
      await message.reply(chunk).catch(() => message.channel.send(chunk).catch(() => {}));
    }
  } catch (err) {
    console.error('Serbest sohbet (AI) hatası:', err);
  }
});

// Anlık Audit Log DM Alarmı
client.on(Events.GuildAuditLogEntryCreate, async (auditLogEntry, guild) => {
  try {
    const { action, executorId, targetId, reason } = auditLogEntry;
    const watchedActions = [
      'ChannelDelete',
      'RoleDelete',
      'MemberBanAdd',
      'MemberKick',
      'MemberUpdate', // timeout/mute değişiklikleri de burada geçebilir
    ];

    if (!watchedActions.includes(action)) return;

    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner) return;

    const executor = executorId ? await client.users.fetch(executorId).catch(() => null) : null;

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🚨 Güvenlik Uyarısı')
      .setDescription(`**${guild.name}** sunucunuzda kritik bir işlem gerçekleşti.`)
      .addFields(
        { name: 'İşlem', value: String(action), inline: true },
        { name: 'Yetkili', value: executor ? `${executor.tag} (${executor.id})` : 'Bilinmiyor', inline: true },
        { name: 'Hedef ID', value: targetId ? String(targetId) : '—', inline: true },
        { name: 'Sebep', value: reason || '—' }
      )
      .setTimestamp();

    await owner.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('AuditLog alarm hatası:', err);
  }
});

// /kurtar: Hiyerarşik sıfırdan geri yükleme
// Adım bildirimi Discord tarafında (rate limit/zaman aşımı vb.) hata verirse
// bile ASIL kurtarma işlemini (rol/kanal oluşturma) durdurmasın diye ayrı
// bir güvenli fonksiyona alındı.
async function safeStatusUpdate(interaction, text) {
  try {
    await interaction.editReply(text);
  } catch (err) {
    console.error('Durum mesajı gönderilemedi (işleme devam ediliyor):', err.message || err);
  }
}

async function runKurtar(interaction) {
  const guild = interaction.guild;
  try {
    const row = db.prepare('SELECT backup_json FROM server_backups WHERE guild_id = ?').get(guild.id);
    if (!row) {
      return safeStatusUpdate(interaction, '❌ Bu sunucu için kayıtlı bir yedek bulunamadı.');
    }
    const backup = JSON.parse(row.backup_json);

    await safeStatusUpdate(interaction, '🔧 Adım 1/4: Mevcut roller siliniyor...');
    const rolesToDelete = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed && r.editable)
      .sort((a, b) => b.position - a.position);
    for (const role of rolesToDelete.values()) {
      await role.delete('Kurtar işlemi: eski rol temizleniyor').catch((e) => console.error('Rol silme hatası:', e));
    }

    await safeStatusUpdate(interaction, '🔧 Adım 2/4: Mevcut kanallar siliniyor...');
    const channelsToDelete = guild.channels.cache;
    for (const channel of channelsToDelete.values()) {
      await channel.delete('Kurtar işlemi: eski kanal temizleniyor').catch((e) => console.error('Kanal silme hatası:', e));
    }

    await safeStatusUpdate(interaction, '🔧 Adım 3/4: Roller yedekten sıfırdan kuruluyor...');
    const idMap = new Map(); // oldId -> newId
    // Yönetilen (managed - entegrasyon/bot) roller tekrar oluşturulmaya
    // çalışılmasın diye yedekten filtrelenir.
    const sortedRoles = [...backup.roles].filter((r) => !r.managed).sort((a, b) => a.position - b.position);
    for (const r of sortedRoles) {
      try {
        const newRole = await guild.roles.create({
          name: r.name,
          color: r.color,
          hoist: r.hoist,
          mentionable: r.mentionable,
          permissions: BigInt(r.permissions),
          reason: 'Kurtar işlemi: rol geri yükleniyor',
        });
        idMap.set(r.oldId, newRole.id);
      } catch (e) {
        console.error('Rol oluşturma hatası:', e);
      }
    }

    await safeStatusUpdate(interaction, '🔧 Adım 4/4: Kanallar kuruluyor ve izinler senkronize ediliyor...');
    const parentIdMap = new Map();
    const sortedChannels = [...backup.channels].sort((a, b) => a.position - b.position);

    // Önce kategorileri oluştur
    for (const ch of sortedChannels.filter((c) => c.type === ChannelType.GuildCategory)) {
      try {
        const overwrites = ch.permissionOverwrites
          .map((po) => remapOverwrite(po, guild, idMap))
          .filter(Boolean);
        const newCh = await guild.channels.create({
          name: ch.name,
          type: ChannelType.GuildCategory,
          permissionOverwrites: overwrites,
          reason: 'Kurtar işlemi: kategori geri yükleniyor',
        });
        parentIdMap.set(ch.oldId, newCh.id);
      } catch (e) {
        console.error('Kategori oluşturma hatası:', e);
      }
    }

    // Sonra diğer kanalları oluştur
    for (const ch of sortedChannels.filter((c) => c.type !== ChannelType.GuildCategory)) {
      try {
        const overwrites = ch.permissionOverwrites
          .map((po) => remapOverwrite(po, guild, idMap))
          .filter(Boolean);
        await guild.channels.create({
          name: ch.name,
          type: ch.type,
          parent: ch.parentOldId ? parentIdMap.get(ch.parentOldId) || null : null,
          topic: ch.topic || undefined,
          nsfw: ch.nsfw,
          bitrate: ch.bitrate,
          userLimit: ch.userLimit,
          permissionOverwrites: overwrites,
          reason: 'Kurtar işlemi: kanal geri yükleniyor',
        });
      } catch (e) {
        console.error('Kanal oluşturma hatası:', e);
      }
    }

    await interaction.followUp({ content: `${addressPrefix(interaction.user.id)}✅ Sunucu yedekten başarıyla geri yüklendi!`, ephemeral: true }).catch((e) =>
      console.error('Kurtar bitiş mesajı gönderilemedi:', e)
    );
  } catch (err) {
    console.error('runKurtar hatası:', err);
    await interaction.followUp({ content: '❌ Kurtarma sırasında bir hata oluştu, loglara bakın.', ephemeral: true }).catch(() => {});
  }
}

function remapOverwrite(po, guild, idMap) {
  try {
    let id = po.id;
    if (po.type === 0) {
      // rol
      if (po.id === guild.id) {
        id = guild.id; // @everyone sabit kalır
      } else {
        id = idMap.get(po.id);
        if (!id) return null; // eski rol artık yoksa atla
      }
    }
    return {
      id,
      type: po.type,
      allow: BigInt(po.allow),
      deny: BigInt(po.deny),
    };
  } catch (e) {
    console.error('remapOverwrite hatası:', e);
    return null;
  }
}

// /karantina: Akıllı karantina (önceden kilitli kanalları koru)
function getOriginalSendState(channel, guild) {
  const po = channel.permissionOverwrites.cache.get(guild.id); // @everyone
  if (!po) return 'inherit';
  if (po.deny.has(PermissionFlagsBits.SendMessages)) return 'deny';
  if (po.allow.has(PermissionFlagsBits.SendMessages)) return 'allow';
  return 'inherit';
}

async function activateQuarantine(interaction) {
  const guild = interaction.guild;
  try {
    const textLike = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
    );

    const insertLock = db.prepare(
      `INSERT INTO quarantine_locks (guild_id, channel_id, original_state) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, channel_id) DO UPDATE SET original_state = excluded.original_state`
    );

    for (const channel of textLike.values()) {
      const originalState = getOriginalSendState(channel, guild);
      insertLock.run(guild.id, channel.id, originalState);

      if (originalState !== 'deny') {
        await channel.permissionOverwrites
          .edit(guild.id, { SendMessages: false }, { reason: 'Karantina aktif edildi' })
          .catch((e) => console.error('Karantina kilitleme hatası:', e));
      }
    }

    db.prepare(
      `INSERT INTO quarantine_status (guild_id, active) VALUES (?, 1)
       ON CONFLICT(guild_id) DO UPDATE SET active = 1`
    ).run(guild.id);

    await interaction.editReply('🔒 Karantina etkinleştirildi. Tüm kanallar kilitlendi.');
  } catch (err) {
    console.error('activateQuarantine hatası:', err);
    await interaction.editReply('❌ Karantina etkinleştirilirken hata oluştu.').catch(() => {});
  }
}

async function deactivateQuarantine(interaction) {
  const guild = interaction.guild;
  try {
    const locks = db.prepare('SELECT * FROM quarantine_locks WHERE guild_id = ?').all(guild.id);

    for (const lock of locks) {
      const channel = guild.channels.cache.get(lock.channel_id);
      if (!channel) continue;

      // Zaten önceden kilitliyse (deny) dokunma -> orijinal durumunu koru
      if (lock.original_state === 'deny') continue;

      if (lock.original_state === 'inherit') {
        // Karantina öncesi hiç override yoktu -> override'ı tamamen kaldır
        await channel.permissionOverwrites
          .delete(guild.id, 'Karantina kaldırıldı: orijinal duruma dönülüyor')
          .catch((e) => console.error('Karantina kaldırma hatası:', e));
      } else if (lock.original_state === 'allow') {
        await channel.permissionOverwrites
          .edit(guild.id, { SendMessages: true }, { reason: 'Karantina kaldırıldı: orijinal duruma dönülüyor' })
          .catch((e) => console.error('Karantina kaldırma hatası:', e));
      }
    }

    db.prepare('DELETE FROM quarantine_locks WHERE guild_id = ?').run(guild.id);
    db.prepare(
      `INSERT INTO quarantine_status (guild_id, active) VALUES (?, 0)
       ON CONFLICT(guild_id) DO UPDATE SET active = 0`
    ).run(guild.id);

    await interaction.editReply('🔓 Karantina kaldırıldı. Önceden zaten kilitli olan kanallar kilitli kalmaya devam ediyor.');
  } catch (err) {
    console.error('deactivateQuarantine hatası:', err);
    await interaction.editReply('❌ Karantina kaldırılırken hata oluştu.').catch(() => {});
  }
}

// INTERACTION HANDLER
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    // -------------------- /ekle --------------------
    if (commandName === 'ekle') {
      await interaction.deferReply({ ephemeral: true });

      const inviteInput = interaction.options.getString('sunucu_davet_linki').trim();
      const price = getPrice();
      const credits = getCredits(interaction.user.id);

      if (credits < price) {
        return interaction.editReply(`❌ Yetersiz kredi! Gereken: **${price}**, mevcut: **${credits}**.`);
      }

      // Davet linkini çözümle (sunucuya KATILMADAN sadece bilgi çek)
      const inviteCode = inviteInput.split('/').pop().replace(/\s/g, '');
      let invite;
      try {
        invite = await client.fetchInvite(inviteCode);
      } catch (e) {
        return interaction.editReply('❌ Geçersiz veya süresi dolmuş davet linki.');
      }

      if (!invite.guild) {
        return interaction.editReply('❌ Bu davet linkinden bir sunucu bilgisi alınamadı.');
      }

      // Bot zaten bu sunucudaysa
      if (client.guilds.cache.has(invite.guild.id)) {
        return interaction.editReply('ℹ️ Bot zaten bu sunucuda mevcut.');
      }

      // Bekleyen istek oluştur (kredi henüz düşülmüyor, bot gerçekten katılınca düşülecek)
      db.prepare(
        `INSERT INTO pending_invites (user_id, guild_id, guild_name, cost, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(interaction.user.id, invite.guild.id, invite.guild.name, price, Date.now());

      const authUrl =
        `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}` +
        `&permissions=${BOT_INVITE_PERMISSIONS}` +
        `&scope=bot%20applications.commands` +
        `&guild_id=${invite.guild.id}` +
        `&disable_guild_select=true`;

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🔗 Yetkilendirme gerekiyor')
        .setDescription(
          `**${invite.guild.name}** sunucusuna botu eklemek için aşağıdaki resmi Discord linkine tıklayın ve onaylayın.\n\n` +
            `Bot sunucuya katıldığı anda **${price} kredi** hesabınızdan otomatik olarak düşülecek.\n\n[Botu Sunucuma Ekle](${authUrl})`
        );

      return interaction.editReply({ embeds: [embed] });
    }

    // -------------------- /kredi --------------------
    if (commandName === 'kredi') {
      const credits = getCredits(interaction.user.id);
      return interaction.reply({
        content: `${addressPrefix(interaction.user.id)}💰 Krediniz: **${credits}**`,
        ephemeral: true,
      });
    }

    // -------------------- /fiyat-ayarla --------------------
    if (commandName === 'fiyat-ayarla') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: '❌ Bu komutu yalnızca bot sahibi kullanabilir.', ephemeral: true });
      }
      const newPrice = interaction.options.getInteger('fiyat');
      setSetting('ekle_fiyat', newPrice);
      return interaction.reply({ content: `Patronum, /ekle fiyatı **${newPrice}** kredi olarak güncellendi. ✅`, ephemeral: true });
    }

    // -------------------- /kredi-ver --------------------
    if (commandName === 'kredi-ver') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: '❌ Bu komutu yalnızca bot sahibi kullanabilir.', ephemeral: true });
      }
      const targetUser = interaction.options.getUser('kullanici');
      const amount = interaction.options.getInteger('miktar');
      const newBalance = addCredits(targetUser.id, amount);
      return interaction.reply({
        content: `Patronum, ${targetUser.tag} kullanıcısına ${amount} kredi eklendi. Yeni bakiye: **${newBalance}** ✅`,
        ephemeral: true,
      });
    }

    // -------------------- /kredisil --------------------
    if (commandName === 'kredisil') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: '❌ Bu komutu yalnızca bot sahibi kullanabilir.', ephemeral: true });
      }
      const targetUser = interaction.options.getUser('kullanici');
      const amount = interaction.options.getInteger('miktar');
      const newBalance = deductCredits(targetUser.id, amount);
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('🗑️ Kredi silindi')
        .setDescription(`${targetUser.tag} kullanıcısından **${amount}** kredi silindi.\nYeni bakiye: **${newBalance}**`);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // -------------------- /sunucular --------------------
    if (commandName === 'sunucular') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));

        if (guilds.length === 0) {
          return interaction.editReply('ℹ️ Bot şu anda hiçbir sunucuda değil.');
        }

        const lines = guilds.map((g) => `**${g.name}**\n\`${g.id}\`  •  👥 ${g.memberCount ?? '?'}`);

        // Discord embed description limiti 4096 karakter -> gerekirse birden fazla embed'e böl
        const embeds = [];
        let current = '';
        for (const line of lines) {
          if ((current + '\n\n' + line).length > 3900) {
            embeds.push(current);
            current = line;
          } else {
            current = current ? `${current}\n\n${line}` : line;
          }
        }
        if (current) embeds.push(current);

        const finalEmbeds = embeds.slice(0, 10).map((desc, i) =>
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(i === 0 ? `🌐 Botun bulunduğu sunucular (${guilds.length})` : `🌐 Sunucular (devamı)`)
            .setDescription(desc)
        );

        return interaction.editReply({ embeds: finalEmbeds });
      } catch (err) {
        console.error('/sunucular hatası:', err);
        return interaction.editReply('❌ Sunucular listelenirken bir hata oluştu.');
      }
    }

    // -------------------- /cik --------------------
    if (commandName === 'cik') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: '❌ Bu komutu yalnızca bot sahibi kullanabilir.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const guildId = interaction.options.getString('sunucu_id').trim();
        const targetGuild = client.guilds.cache.get(guildId);

        if (!targetGuild) {
          return interaction.editReply('❌ Bot bu ID\'ye sahip bir sunucuda bulunmuyor.');
        }

        const guildName = targetGuild.name;
        const memberCount = targetGuild.memberCount;

        const embed = new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('🚪 Sunucudan çıkılıyor')
          .setDescription(`**${guildName}**\n\`${guildId}\`  •  👥 ${memberCount ?? '?'}`);

        // ÖNEMLİ: Cevabı önce gönderiyoruz. Komut, çıkılacak sunucunun içinde
        // çalıştırılmışsa, bot sunucudan ayrıldıktan SONRA cevap vermeye
        // çalışmak "Invalid Webhook Token" hatası verir (etkileşim jetonu o
        // sunucuya bağlıdır ve bot ayrılınca geçersiz kalır).
        await interaction.editReply({ embeds: [embed] });
        await targetGuild.leave();
        saveGuildsSnapshot();
        return;
      } catch (err) {
        console.error('/cik hatası:', err);
        return interaction.editReply('❌ Sunucudan çıkılırken bir hata oluştu.');
      }
    }

    // -------------------- /kurtar --------------------
    if (commandName === 'kurtar') {
      if (!interaction.guild) return interaction.reply({ content: '❌ Bu komut yalnızca sunucularda kullanılabilir.', ephemeral: true });
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Bu komutu yalnızca sunucu sahibi kullanabilir.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      await runKurtar(interaction);
      return;
    }

    // -------------------- /karantina --------------------
    if (commandName === 'karantina') {
      if (!interaction.guild) return interaction.reply({ content: '❌ Bu komut yalnızca sunucularda kullanılabilir.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const durum = interaction.options.getString('durum');
      if (durum === 'ac') {
        await activateQuarantine(interaction);
      } else {
        await deactivateQuarantine(interaction);
      }
      return;
    }

    // -------------------- /ban --------------------
    if (commandName === 'ban') {
      const targetUser = interaction.options.getUser('kullanici');
      const reason = interaction.options.getString('sebep') || 'Belirtilmedi';
      await interaction.guild.members.ban(targetUser.id, { reason });
      return interaction.reply({ content: `🔨 ${targetUser.tag} yasaklandı. Sebep: ${reason}`, ephemeral: true });
    }

    // -------------------- /unban --------------------
    if (commandName === 'unban') {
      const userId = interaction.options.getString('kullanici_id');
      await interaction.guild.members.unban(userId);
      return interaction.reply({ content: `✅ ${userId} kullanıcısının yasağı kaldırıldı.`, ephemeral: true });
    }

    // -------------------- /mute --------------------
    if (commandName === 'mute') {
      const targetUser = interaction.options.getUser('kullanici');
      const minutes = interaction.options.getInteger('dakika');
      const reason = interaction.options.getString('sebep') || 'Belirtilmedi';
      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.timeout(minutes * 60 * 1000, reason);
      return interaction.reply({ content: `🔇 ${targetUser.tag} ${minutes} dakika susturuldu.`, ephemeral: true });
    }

    // -------------------- /unmute --------------------
    if (commandName === 'unmute') {
      const targetUser = interaction.options.getUser('kullanici');
      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.timeout(null, 'Susturma manuel kaldırıldı');
      return interaction.reply({ content: `🔊 ${targetUser.tag} kullanıcısının susturması kaldırıldı.`, ephemeral: true });
    }

    // -------------------- /sohbet kilitle | ac --------------------
    if (commandName === 'sohbet') {
      const sub = interaction.options.getSubcommand();
      const channel = interaction.channel;
      if (sub === 'kilitle') {
        await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false }, { reason: 'Manuel kanal kilitleme' });
        return interaction.reply({ content: '🔒 Bu kanal kilitlendi.', ephemeral: true });
      } else if (sub === 'ac') {
        await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null }, { reason: 'Manuel kanal kilidi açma' });
        return interaction.reply({ content: '🔓 Bu kanalın kilidi açıldı.', ephemeral: true });
      }
    }
  } catch (err) {
    console.error(`Komut hatası (${commandName}):`, err);
    const errMsg = '❌ Komut çalıştırılırken beklenmeyen bir hata oluştu.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errMsg).catch(() => {});
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
    }
  }
});

// BAŞLATMA
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Giriş yapıldı: ${c.user.tag}`);
  await registerCommands();
  await catchUpMissedGuilds();
  saveGuildsSnapshot();
});

// GİRİŞ (retry destekli): Termux'ta mobil ağ/WiFi geçişleri kısa süreli
// bağlantı zaman aşımlarına sebep olabilir. Bunlarda process'i kapatmak
// yerine artan bekleme süreleriyle otomatik tekrar dener; sadece token
// gerçekten geçersizse (kimlik doğrulama hatası) kapanır.
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);

function isNetworkError(err) {
  if (!err) return false;
  if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
  if (err.cause && err.cause.code && NETWORK_ERROR_CODES.has(err.cause.code)) return true;
  const msg = String(err.message || '');
  return /timeout|network|fetch failed|ECONNRESET|ENOTFOUND/i.test(msg);
}

async function loginWithRetry(attempt = 1) {
  const MAX_DELAY_MS = 5 * 60 * 1000; // en fazla 5 dakika bekle
  try {
    await client.login(TOKEN);
  } catch (err) {
    if (isNetworkError(err)) {
      const delay = Math.min(5000 * attempt, MAX_DELAY_MS);
      console.error(
        `Bot giriş hatası (ağ sorunu, deneme ${attempt}): ${err.message}. ${Math.round(delay / 1000)} saniye sonra tekrar denenecek...`
      );
      setTimeout(() => loginWithRetry(attempt + 1), delay);
    } else {
      console.error('Bot giriş hatası (ağ dışı / muhtemelen geçersiz TOKEN):', err);
      process.exit(1);
    }
  }
}

loginWithRetry();
