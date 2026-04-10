// ===== IMPORTS =====
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;

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

// ===== APP =====
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// ===== DEVICE DETECTION =====
function detectDevice(text) {
  const t = text.toLowerCase();

  if (t.includes("barco") || t.includes("e2")) return "Barco E2";
  if (t.includes("novastar")) return "Novastar";
  if (t.includes("ptz")) return "PTZ";
  if (t.includes("teradek") || t.includes("dji")) return "Wireless";

  return "system";
}

// ===== FLOW =====
function getFlow(device) {
  if (device === "Barco E2") {
    return [
      { q: "Is input detected? (Menu → Input → Status)", yes: 1, no: "fix_input" },
      { q: "Is input routed correctly? (Menu → Destination)", yes: 2, no: "fix_routing" },
      { q: "Is layer visible? (Menu → Layers)", yes: 3, no: "fix_layer" },
      { q: "Is output correct? (Menu → Outputs)", yes: "done", no: "fix_output" }
    ];
  }

  if (device === "Novastar") {
    return [
      { q: "Correct input selected? (Menu → Input Settings)", yes: 1, no: "fix_input" },
      { q: "Signal detected? (Menu → Status)", yes: 2, no: "fix_input" },
      { q: "Mapping correct? (Screen Config)", yes: 3, no: "fix_mapping" },
      { q: "Brightness above 0? (Display Control)", yes: "done", no: "fix_output" }
    ];
  }

  return [
    { q: "Is the source outputting signal?", yes: 1, no: "fix_input" },
    { q: "Is signal reaching next device?", yes: 2, no: "fix_cable" },
    { q: "Is output device correct?", yes: "done", no: "fix_output" }
  ];
}

// ===== FIXES =====
function getFix(action) {
  const fixes = {
    fix_input: "🔧 Check source output and input selection.",
    fix_routing: "🔧 Check routing configuration.",
    fix_layer: "🔧 Ensure layer is visible.",
    fix_output: "🔧 Check display input/source.",
    fix_mapping: "🔧 Verify LED mapping.",
    fix_cable: "🔧 Check cabling."
  };
  return fixes[action] || "🔧 Check system.";
}

// ===== FLOW STATE =====
async function getFlowState(id) {
  const data = await redis.get(`flow:${id}`);
  return data ? JSON.parse(data) : null;
}

async function saveFlowState(id, state) {
  await redis.set(`flow:${id}`, JSON.stringify(state), "EX", 3600);
}

async function clearFlowState(id) {
  await redis.del(`flow:${id}`);
}

// ===== MAIN HANDLER =====
app.event('message', async ({ event, say, client }) => {
  try {
    console.log("🔥 EVENT RECEIVED:", event.text);

    // ignore bots
    if (event.bot_id || event.subtype) {
      console.log("⛔ Ignored bot message");
      return;
    }

    // OPTIONAL channel filter (safe now)
    if (process.env.HELP_CHANNEL_ID) {
      if (event.channel !== process.env.HELP_CHANNEL_ID) {
        console.log("⛔ Wrong channel");
        return;
      }
    }

    // ===== DEDUPE =====
    const eventKey = `event:${event.ts}`;
    if (await redis.get(eventKey)) {
      console.log("⛔ Duplicate event");
      return;
    }
    await redis.set(eventKey, "1", "EX", 60);

    const threadTs = event.thread_ts || event.ts;
    const text = event.text.toLowerCase();

    // 👀 reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(err => console.log("Reaction error:", err));

    const flowState = await getFlowState(threadTs);

    // ===== START FLOW =====
    if (!flowState) {
      const device = detectDevice(text);
      const steps = getFlow(device);

      await saveFlowState(threadTs, { step: 0, steps });

      await say({
        thread_ts: threadTs,
        text: `🔍 Starting troubleshooting (${device})\n\n${steps[0].q}`
      });

      console.log("✅ Flow started");
      return;
    }

    // ===== HANDLE ANSWER =====
    const step = flowState.steps[flowState.step];

    let branch;
    if (text.includes("yes")) branch = "yes";
    else if (text.includes("no")) branch = "no";
    else {
      await say({
        thread_ts: threadTs,
        text: "Reply with *yes* or *no*"
      });
      return;
    }

    const next = step[branch];

    if (typeof next === "string" && next.startsWith("fix")) {
      await say({
        thread_ts: threadTs,
        text: getFix(next)
      });

      await clearFlowState(threadTs);
      console.log("✅ Fix provided");
      return;
    }

    if (next === "done") {
      await say({
        thread_ts: threadTs,
        text: "✅ Troubleshooting complete. Escalate if unresolved."
      });

      await clearFlowState(threadTs);
      console.log("✅ Flow complete");
      return;
    }

    flowState.step = next;
    await saveFlowState(threadTs, flowState);

    await say({
      thread_ts: threadTs,
      text: flowState.steps[next].q
    });

    console.log("➡️ Next step");

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running`);
});