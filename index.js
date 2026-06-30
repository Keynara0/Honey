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
  ACTION: process.env.ACTION || 'kick', // 'kick' atau 'ban'
  DATA_FILE: './data.json',
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
      return JSON.parse(raw);
    }
  } catch {}
  return { kickCount: 0 };
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

console.log(`📂 Data dimuat. Ban count: ${kickCount}`);

client.once('clientReady', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  await initHoneypotMessage();
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

  const messages = await channel.messages.fetch({ limit: 20 });
  const botMessages = messages.filter(m => m.author.id === client.user.id);
  for (const [, msg] of botMessages) {
    try { await msg.delete(); } catch {}
  }

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
    saveData();
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

client.login(CONFIG.TOKEN);
