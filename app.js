// ===== IMPORTS =====
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;

import dotenv from 'dotenv';

dotenv.config();

// ===== RECEIVER =====
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true
});

// ===== APP =====
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// ===== MAIN HANDLER =====
app.event('message', async ({ event, say, client }) => {
  try {
    console.log("🔥 EVENT RECEIVED");
    console.log(JSON.stringify(event, null, 2));

    // ignore bot messages
    if (event.bot_id || event.subtype) {
      console.log("⛔ Ignored bot message");
      return;
    }

    // OPTIONAL: channel filter (disable for now)
    if (process.env.HELP_CHANNEL_ID) {
      if (event.channel !== process.env.HELP_CHANNEL_ID) {
        console.log("⛔ Wrong channel:", event.channel);
        return;
      }
    }

    // 👀 reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(err => console.log("Reaction error:", err));

    // 💬 reply
    await say({
      thread_ts: event.thread_ts || event.ts,
      text: "✅ Bot is alive and responding"
    });

    console.log("✅ Response sent");

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});