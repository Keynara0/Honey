const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ===================== CONFIG =====================
const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  HONEYPOT_CHANNEL_ID: process.env.HONEYPOT_CHANNEL_ID,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID,
  LOGO_URL: process.env.LOGO_URL || '',
  ACTION: (process.env.ACTION || 'kick').toLowerCase(), // 'kick' atau 'ban'
  DATA_FILE: process.env.DATA_FILE || './data.json', // gunakan '/data/data.json' kalau pakai Railway Volume
  INITIAL_KICK_COUNT: parseInt(process.env.INITIAL_KICK_COUNT || '0', 10),

  // Member count voice channel
  GUILD_ID: process.env.GUILD_ID,
  MEMBER_COUNT_CHANNEL_ID: process.env.MEMBER_COUNT_CHANNEL_ID,
  MEMBER_COUNT_FORMAT: process.env.MEMBER_COUNT_FORMAT || '👥All Members: {count}',
  MEMBER_COUNT_UPDATE_INTERVAL: parseInt(process.env.MEMBER_COUNT_UPDATE_INTERVAL || '600000', 10), // default 10 menit (ms)
};

// Validasi env wajib
const requiredEnv = ['DISCORD_TOKEN', 'HONEYPOT_CHANNEL_ID', 'LOG_CHANNEL_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`❌ Environment variable ${key} belum diset!`);
    process.exit(1);
  }
}
// ==================================================

// ===================== LOAD / SAVE DATA =====================
function loadData() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const raw = fs.readFileSync(CONFIG.DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.kickCount === 'number') {
        return parsed;
      }
    }
  } catch (err) {
    console.error('⚠️ Gagal load data.json, fallback ke nilai awal:', err.message);
  }
  // Fallback kalau file belum ada / rusak: pakai INITIAL_KICK_COUNT
  return { kickCount: CONFIG.INITIAL_KICK_COUNT };
}

function saveData() {
  try {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify({ kickCount }, null, 2));
  } catch (err) {
    console.error('❌ Gagal simpan data:', err.message);
  }
}

let { kickCount } = loadData();
let honeypotMessageId = null;

console.log(`📂 Data dimuat dari ${CONFIG.DATA_FILE}. Ban/Kick count: ${kickCount}`);

client.once('clientReady', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  await initHoneypotMessage();

  // Update member count channel pertama kali saat bot start
  await updateMemberCountChannel();
  // Update berkala (default tiap 10 menit, sesuai limit rename channel Discord)
  setInterval(updateMemberCountChannel, CONFIG.MEMBER_COUNT_UPDATE_INTERVAL);
});

// ===================== BUILD PAYLOAD =====================
function buildPayload() {
  return {
    content: null,
    embeds: [],
    flags: 1 << 15,
    components: [
      {
        type: 17,
        components: [
          {
            type: 9,
            components: [
              {
                type: 10,
                content: '## DO NOT SEND MESSAGES IN THIS CHANNEL',
              },
              {
                type: 10,
                content: 'This channel is used to catch spam bots. Any messages sent here will result in a **softban**.',
              },
            ],
            accessory: {
              type: 11,
              media: { url: CONFIG.LOGO_URL },
            },
          },
          {
            type: 14,
            divider: false,
            spacing: 1,
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: `🚫Ban: ${kickCount}`,
                custom_id: 'kicks_counter',
                disabled: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

// ===================== INIT MESSAGE =====================
async function initHoneypotMessage() {
  const channel = await client.channels.fetch(CONFIG.HONEYPOT_CHANNEL_ID);
  if (!channel) return console.error('❌ Channel tidak ditemukan!');

  // Hapus pesan bot lama
  const messages = await channel.messages.fetch({ limit: 20 });
  const botMessages = messages.filter(m => m.author.id === client.user.id);
  for (const [, msg] of botMessages) {
    try { await msg.delete(); } catch {}
  }

  // Kirim pesan baru
  const res = await client.rest.post(
    `/channels/${CONFIG.HONEYPOT_CHANNEL_ID}/messages`,
    { body: buildPayload() }
  );

  honeypotMessageId = res.id;
  console.log(`📌 Honeypot message dibuat. ID: ${honeypotMessageId}`);
}

// ===================== UPDATE MESSAGE =====================
async function updateMessage() {
  try {
    await client.rest.patch(
      `/channels/${CONFIG.HONEYPOT_CHANNEL_ID}/messages/${honeypotMessageId}`,
      { body: buildPayload() }
    );
  } catch (err) {
    console.error('❌ Gagal update:', err.message);
  }
}

// ===================== HONEYPOT TRIGGER =====================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CONFIG.HONEYPOT_CHANNEL_ID) return;

  const member = message.member;
  if (!member) return;

  try { await message.delete(); } catch {}

  try {
    if (CONFIG.ACTION === 'kick') {
      await member.kick('Honeypot triggered');
    } else {
      await member.ban({ reason: 'Honeypot triggered', deleteMessageSeconds: 86400 });
    }

    kickCount++;
    saveData(); // simpan ke file
    console.log(`🔨 ${CONFIG.ACTION} ${message.author.tag} | Total: ${kickCount}`);

    await updateMessage();
    await sendLog(message.author);
  } catch (err) {
    console.error(`❌ Gagal ${CONFIG.ACTION}:`, err.message);
  }
});

// ===================== LOG =====================
async function sendLog(user) {
  try {
    const logChannel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID);
    const logEmbed = new EmbedBuilder()
      .setTitle(`🔨 Honeypot Triggered`)
      .setDescription(`**User:** ${user.tag} (${user.id})\n**Action:** ${CONFIG.ACTION}\n**Total:** ${kickCount}`)
      .setColor(0xff4444)
      .setTimestamp();
    await logChannel.send({ embeds: [logEmbed] });
  } catch {}
}

// ===================== MEMBER COUNT VOICE CHANNEL =====================
async function updateMemberCountChannel() {
  if (!CONFIG.GUILD_ID || !CONFIG.MEMBER_COUNT_CHANNEL_ID) return;

  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const memberCount = guild.memberCount;

    const channel = await guild.channels.fetch(CONFIG.MEMBER_COUNT_CHANNEL_ID);
    if (!channel) return console.error('❌ Member count channel tidak ditemukan!');

    const newName = CONFIG.MEMBER_COUNT_FORMAT.replace('{count}', memberCount.toLocaleString('en-US'));

    if (channel.name !== newName) {
      await channel.setName(newName);
      console.log(`👥 Member count channel diupdate: ${newName}`);
    }
  } catch (err) {
    console.error('❌ Gagal update member count channel:', err.message);
  }
}

client.login(CONFIG.TOKEN);
