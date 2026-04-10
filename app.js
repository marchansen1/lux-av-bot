// ===== IMPORTS =====
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;

import dotenv from 'dotenv';
import Redis from 'ioredis';
import OpenAI from 'openai';

dotenv.config();

// ===== RECEIVER =====
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true
});

// ===== SERVICES =====
const redis = new Redis(process.env.REDIS_URL);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
    console.log("🔥 EVENT:", event.text);

    if (event.bot_id || event.subtype) return;

    if (process.env.HELP_CHANNEL_ID && event.channel !== process.env.HELP_CHANNEL_ID) {
      return;
    }

    // ===== DEDUPE =====
    const eventKey = `event:${event.ts}`;
    if (await redis.get(eventKey)) return;
    await redis.set(eventKey, "1", "EX", 60);

    const threadTs = event.thread_ts || event.ts;
    const text = event.text.toLowerCase();

    // 👀 reaction
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    const flowState = await getFlowState(threadTs);

    // ===== NEW ISSUE → AI FIRST =====
    if (!flowState) {
      const device = detectDevice(text);

      let aiReply = "🔧 Let’s troubleshoot this.";

      try {
        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `You are a senior AV technician.

Give a short, practical diagnosis and next step.
Include menu paths where useful.
Be concise.`
            },
            {
              role: "user",
              content: text
            }
          ]
        });

        aiReply = ai.choices[0].message.content;
      } catch (err) {
        console.log("AI error:", err.message);
      }

      const steps = getFlow(device);

      await saveFlowState(threadTs, { step: 0, steps });

      await say({
        thread_ts: threadTs,
        text: `${aiReply}\n\n---\n🔧 Step 1:\n${steps[0].q}`
      });

      return;
    }

    // ===== SMART MODE SWITCHING =====
    const step = flowState.steps[flowState.step];

    const isSimple =
      text.trim() === "yes" ||
      text.trim() === "no";

    // ===== COMPLEX RESPONSE → AI =====
    if (!isSimple) {
      let aiReply = "";

      try {
        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `You are a senior AV technician continuing troubleshooting.

Respond naturally to the technician update.
Give the next best action.
Be concise and practical.`
            },
            {
              role: "user",
              content: text
            }
          ]
        });

        aiReply = ai.choices[0].message.content;
      } catch (err) {
        aiReply = "⚠️ Could not interpret response.";
      }

      await say({
        thread_ts: threadTs,
        text: aiReply
      });

      return;
    }

    // ===== YES/NO → FLOW =====
    const branch = text.trim();
    const next = step[branch];

    if (typeof next === "string" && next.startsWith("fix")) {
      await say({
        thread_ts: threadTs,
        text: getFix(next)
      });

      await clearFlowState(threadTs);
      return;
    }

    if (next === "done") {
      await say({
        thread_ts: threadTs,
        text: "✅ Troubleshooting complete. Escalate if still unresolved."
      });

      await clearFlowState(threadTs);
      return;
    }

    flowState.step = next;
    await saveFlowState(threadTs, flowState);

    await say({
      thread_ts: threadTs,
      text: `🔧 Step ${next + 1}:\n${flowState.steps[next].q}`
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running`);
});