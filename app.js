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

// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `You are Lux AV Help Desk, a live event AV technician assistant.

CRITICAL RULES:
- Be concise and operational
- Assume user is on-site under time pressure
- Prioritize fastest workaround first
- Max 3 questions before giving a path
- No theory without action

FORMAT EXACTLY:

Likely issue:
Immediate safety checks:
Fast diagnostic path:
Fix / workaround:
Next test if unresolved:
Escalate to:
Incident log:`;

// ===== CONTEXT DETECTION =====
function detectContext(text) {
  const t = text.toLowerCase();

  if (t.includes("hdmi")) return "HDMI signal path issue (EDID / handshake / cable)";
  if (t.includes("sdi")) return "SDI signal path issue (BNC / converter / routing)";
  if (t.includes("wireless") || t.includes("barco") || t.includes("clickshare"))
    return "Wireless presentation issue (pairing / network / dongle)";
  if (t.includes("mic") || t.includes("audio"))
    return "Audio signal issue (gain / mute / routing)";
  if (t.includes("power"))
    return "Power issue (supply / distro / IEC)";

  if (t.includes("no signal"))
    return "Display signal issue (cable / input / source mismatch)";

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

    // ===== AI =====
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + priorityNote },
        { role: 'system', content: `Context: ${contextHint}` },
        { role: 'user', content: history.join('\n') }
      ]
    });

    const reply = completion.choices[0].message.content;

    // ===== RESPONSE + BUTTONS =====
    await say({
      thread_ts: threadTs,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: reply }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "No Signal" },
              value: "no_signal"
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Audio Issue" },
              value: "audio"
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Wireless" },
              value: "wireless"
            }
          ]
        }
      ]
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

// ===== BUTTON HANDLER =====
slackApp.action(/.*/, async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0].value;

  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts || body.message.ts,
    text: `Quick triage selected: *${action}*`
  });
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