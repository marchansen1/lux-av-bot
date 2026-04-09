// Lux AV Help Desk Slack Bot (Production Grade)

// ===== IMPORTS =====
import { App } from '@slack/bolt';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

// ===== INIT =====
const redis = new Redis(process.env.REDIS_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
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
  await redis.set(threadTs, JSON.stringify(messages), 'EX', 86400); // 24h TTL
}

// ===== BUTTONS =====
function actionButtons() {
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No Signal' },
          value: 'no_signal',
          action_id: 'no_signal'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Audio Issue' },
          value: 'audio',
          action_id: 'audio'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'RF Issue' },
          value: 'rf',
          action_id: 'rf'
        }
      ]
    }
  ];
}

// ===== MESSAGE HANDLER =====
slackApp.event('message', async ({ event, client }) => {
  try {
    if (event.bot_id || !event.text) return;

    // Only respond in helpdesk channel
    if (!(await isHelpChannel(client, event.channel))) return;

    const threadTs = event.thread_ts || event.ts;

    // 👀 Processing reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    // Get incident history
    let history = await getIncident(threadTs);
    history.push(event.text);
    history = history.slice(-10);
    await saveIncident(threadTs, history);

    // Priority detection
    let priorityNote = '';
    if (isCritical(event.text)) {
      priorityNote = '\nPRIORITY: SHOW CRITICAL - fastest workaround first.';

      // Escalation alert
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `🚨 Escalation triggered ${process.env.ESCALATION_USER}`
      });
    }

    // AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.3',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + priorityNote },
        { role: 'user', content: history.join('\n') }
      ]
    });

    const reply = completion.choices[0].message.content;

    // Send response with buttons
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: reply,
      blocks: actionButtons()
    });

    // ✅ Mark handled
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'white_check_mark'
    }).catch(() => {});

  } catch (err) {
    console.error(err);
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

// ===== BUTTON HANDLER =====
slackApp.action(/.*/, async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0].value;

  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts || body.message.ts,
    text: `Quick triage selected: ${action}`
  });
});

// ===== START SERVER =====
(async () => {
  await slackApp.start(process.env.PORT || 3000);
  console.log('🚀 Lux AV Help Desk (Production) running');
})();