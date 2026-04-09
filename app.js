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
const SYSTEM_PROMPT = `You are Lux AV Help Desk.

Follow this EXACT structure in every reply:
- Likely issue
- Immediate safety checks
- Fast diagnostic path
- Fix / workaround
- Next test if unresolved
- Escalate to
- Incident log

Be concise, operational, and field-focused.
Max 3 clarifying questions.
Prioritize safety and show continuity.`;

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

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running on port ${PORT}`);
});