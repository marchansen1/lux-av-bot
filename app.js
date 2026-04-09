import express from 'express';
import bodyParser from 'body-parser';
import pkg from '@slack/bolt';
const { App } = pkg;

import OpenAI from 'openai';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const app = express();

// 🚨 CRITICAL: raw body for Slack
app.use(bodyParser.json());

// ===== SLACK URL VERIFICATION (THIS FIXES YOUR ISSUE) =====
app.post('/slack/events', (req, res, next) => {
  if (req.body.type === 'url_verification') {
    return res.send(req.body.challenge);
  }
  next();
});

// ===== SLACK APP =====
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Attach Bolt to Express AFTER verification handler
app.use('/slack/events', slackApp.receiver.router);

// ===== INIT SERVICES =====
const redis = new Redis(process.env.REDIS_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
async function isHelpChannel(client, channel) {
  const info = await client.conversations.info({ channel });
  return info.channel.name === process.env.HELP_CHANNEL;
}

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

// ===== MESSAGE HANDLER =====
slackApp.event('message', async ({ event, client }) => {
  try {
    if (event.bot_id || !event.text) return;

    if (!(await isHelpChannel(client, event.channel))) return;

    const threadTs = event.thread_ts || event.ts;

    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    let history = await getIncident(threadTs);
    history.push(event.text);
    history = history.slice(-10);
    await saveIncident(threadTs, history);

    let priorityNote = '';
    if (isCritical(event.text)) {
      priorityNote = '\nPRIORITY: SHOW CRITICAL - fastest workaround first.';

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `🚨 Escalation triggered ${process.env.ESCALATION_USER}`
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.3',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + priorityNote },
        { role: 'user', content: history.join('\n') }
      ]
    });

    const reply = completion.choices[0].message.content;

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: reply
    });

  } catch (err) {
    console.error(err);
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});