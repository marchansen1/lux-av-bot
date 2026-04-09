// ===== IMPORTS =====
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;

import OpenAI from 'openai';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

// ===== RECEIVER =====
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true
});

// ===== SERVICES =====
const redis = new Redis(process.env.REDIS_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== SLACK APP =====
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// ===== EQUIPMENT PROFILE =====
const EQUIPMENT_PROFILE = `
Lux AV Standard Equipment:

Displays:
- Panasonic projectors
- LG Commercial Displays
- LED walls including Absen and Unilumin
- Novastar LED processors, MCTRL4K, R5, MCTRL660, TB3

Signal:
- Barco E2 presentation switchers
- Blackmagic constellation camera switchers
- Roland V160 switchers
- HDMI distribution
- SDI distribution (Blackmagic and Decimator)
- Lightware UBEX-Pro20-HDMI-R100 and UBEX-Pro20-HDMI-F110

Cameras:
- Blackmagic Broadcast G2
- Panasonic CX350
- Panasonic PTZ cameras (AW-HE130, AW-UE160)
- Panasonic PTZ controllers (AW-RP120, AW-RP50E, AW-RP60)

Wireless:
- Apple TVs
- DJI SDI Transmission kit
- Teradek Bolt XT 1000
- Ubiquity AF-5X Air Fibre

Comms:
- RTS OMS Advanced Master Station
- RTS DBP 4F 4CH Wired Beltpack Substations
- RTS Roameo AP-1800 Wireless Access Point
- RTS Roameo TR-1800 4CH Wireless Beltpack Substations

Audio:
- QSC systems
- d&B audiotechnik system
- JBL Vertec system
- L-Acoustic Syva system
- Shure wireless mics

Cabling:
- SDI (BNC)
- HDMI (including adapters)
- XLR
- DMX
- RJ45 ethernet
- Ethercon 

Common Issues:
- HDMI handshake failures (especially Mac adapters)
- SDI sync loss via converters
- LED Screens have the wrong mapping configuration 
`;

// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `You are Lux AV Help Desk, a senior live event AV technician.

GOAL:
Rapidly diagnose issues with minimal back-and-forth.

RULES:
- Ask up to 3 targeted questions FIRST if cause is unclear
- Only give full troubleshooting steps AFTER narrowing problem
- Prioritize fastest isolation of fault
- No theory, only actionable checks

FORMAT:

Likely issue:
Key questions:
Fast diagnostic path:
Fix / workaround:
Next test if unresolved:
Escalate to:
Incident log:

CRITICAL MODE (🚨 or SHOW CRITICAL):
→ Skip questions
→ Give fastest workaround immediately`;

// ===== CONTEXT DETECTION =====
function detectContext(text) {
  const t = text.toLowerCase();

  if (t.includes("hdmi")) return "HDMI signal path (EDID / handshake)";
  if (t.includes("sdi")) return "SDI signal path (BNC / routing)";
  if (t.includes("clickshare") || t.includes("wireless"))
    return "Wireless presentation system";
  if (t.includes("audio") || t.includes("mic"))
    return "Audio system issue";
  if (t.includes("no signal"))
    return "Display signal issue";

  return "General AV issue";
}

// ===== INCIDENT MEMORY =====
async function getIncident(threadTs) {
  const data = await redis.get(threadTs);
  return data ? JSON.parse(data) : [];
}

async function saveIncident(threadTs, messages) {
  await redis.set(threadTs, JSON.stringify(messages), 'EX', 86400);
}

// ===== MAIN HANDLER =====
slackApp.event('app_mention', async ({ event, say, client }) => {
  try {
    console.log("MENTION EVENT RECEIVED");

    // ignore bot + system messages
    if (event.bot_id || event.subtype) return;

    // ===== DEDUPE =====
    const eventKey = `event:${event.ts}`;
    const alreadyProcessed = await redis.get(eventKey);
    if (alreadyProcessed) return;
    await redis.set(eventKey, "1", "EX", 60);

    const threadTs = event.thread_ts || event.ts;
    const userText = event.text;

    // 👀 reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    // ===== CONTEXT =====
    const contextHint = detectContext(userText);

    // ===== MEMORY =====
    let history = await getIncident(threadTs);
    history.push(userText);
    history = history.slice(-10);
    await saveIncident(threadTs, history);

    // ===== PRIORITY =====
    let priorityNote = "";
    if (userText.toLowerCase().includes("show critical") || userText.includes("🚨")) {
      priorityNote = "\nPRIORITY: SHOW CRITICAL - fastest restore path only.";
    }

    // ===== QUESTION-FIRST LOGIC =====
    const needsQuestions =
      userText.length < 50 ||
      userText.toLowerCase().includes("not working") ||
      userText.toLowerCase().includes("issue");

    // ===== AI CALL =====
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT + priorityNote + (needsQuestions ? "\nAsk questions first." : "")
        },
        { role: 'system', content: EQUIPMENT_PROFILE },
        { role: 'system', content: `Context: ${contextHint}` },
        { role: 'user', content: history.join('\n') }
      ]
    });

    const reply = completion.choices[0].message.content;

    // ===== RESPONSE =====
    await say({
      thread_ts: threadTs,
      text: reply
    });

    // ✅ done reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'white_check_mark'
    }).catch(() => {});

  } catch (err) {
    console.error("ERROR:", err);

    await say({
      text: "⚠️ Help Desk temporarily unavailable. Try again or escalate.",
      thread_ts: event.thread_ts || event.ts
    });
  }
});

// ===== RESOLVE COMMAND =====
slackApp.command('/resolve', async ({ command, ack, client }) => {
  await ack();

  const threadTs = command.thread_ts || command.ts;

  await redis.del(threadTs);

  await client.chat.postMessage({
    channel: command.channel_id,
    thread_ts: threadTs,
    text: '✅ Incident marked as resolved'
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running on port ${PORT}`);
});