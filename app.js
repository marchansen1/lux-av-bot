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

// ===== INIT SERVICES =====
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
- Never give theory without action

FORMAT EXACTLY:

Likely issue:
(1–2 most probable causes only)

Immediate safety checks:
(power, rigging, signal risks only if relevant)

Fast diagnostic path:
(step-by-step, fastest checks first)

Fix / workaround:
(quickest way to restore signal NOW)

Next test if unresolved:
(next logical isolation step)

Escalate to:
(role or team only if needed)

Incident log:
(1-line summary)

If message includes "SHOW CRITICAL" or 🚨:
- Skip explanations
- Give fastest restore path immediately`;

// ===== HELPERS =====
function isCritical(text) {
  return text.toLowerCase().includes('show critical') || text.includes('🚨');
}

async function getIncident(threadTs) {
  const data = await redis.get(threadTs);
  return data ? JSON.parse(data) : [];
}

async function saveIncident(threadTs, messages) {
  await redis.set(threadTs, JSON.stringify(messages), 'EX', 86400);
}

// ===== MAIN HANDLER (MENTIONS) =====
slackApp.event('app_mention', async ({ event, say, client }) => {
  try {
    console.log("MENTION EVENT RECEIVED");

    const threadTs = event.thread_ts || event.ts;
    const userText = event.text;

    // 👀 Processing reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    // Incident memory
    let history = await getIncident(threadTs);
    history.push(userText);
    history = history.slice(-10);
    await saveIncident(threadTs, history);

    // Priority detection
    let priorityNote = '';
    if (isCritical(userText)) {
      priorityNote = '\nPRIORITY: SHOW CRITICAL - fastest workaround first.';

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `🚨 Escalation triggered ${process.env.ESCALATION_USER}`
      });
    }

    // AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + priorityNote },
        { role: 'user', content: history.join('\n') }
      ]
    });

    const reply = completion.choices[0].message.content;

    await say({
      text: reply,
      thread_ts: threadTs
    });
blocks: [
  {
    type: "section",
    text: { type: "mrkdwn", text: reply }
  },
  {
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "No Signal" }, value: "no_signal" },
      { type: "button", text: { type: "plain_text", text: "Audio Issue" }, value: "audio" },
      { type: "button", text: { type: "plain_text", text: "RF Issue" }, value: "rf" }
    ]
  }
]
    // ✅ Mark handled
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'white_check_mark'
    }).catch(() => {});

  } catch (err) {
    console.error("ERROR:", err);
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

catch (err) {
  console.error("ERROR:", err);

  await say({
    text: "⚠️ Help Desk temporarily unavailable (AI issue). Try again or escalate.",
    thread_ts: event.thread_ts || event.ts
  });
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running on port ${PORT}`);
});