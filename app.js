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
- RTS DBP 4F Wired Beltpacks
- RTS Roameo wireless system

Audio:
- QSC
- d&B
- JBL Vertec
- L-Acoustics
- Shure wireless

Cabling:
- SDI
- HDMI
- XLR
- DMX
- RJ45 / Ethercon
`;

// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `You are Lux AV Help Desk, a senior live event AV technician.

- Ask targeted questions first
- Be concise and operational
- Use exact menu paths when relevant
- No theory, only actions

FORMAT:

Likely issue:
Key questions:
Fast diagnostic path:
Fix / workaround:
Next test if unresolved:
Escalate to:
`;

// ===== DETECTION =====
function detectDevice(text) {
  const t = text.toLowerCase();

  if (t.includes("barco") || t.includes("e2")) return "Barco E2";
  if (t.includes("novastar") || t.includes("mctrl")) return "Novastar";
  if (t.includes("ptz") || t.includes("aw-")) return "PTZ";
  if (t.includes("teradek") || t.includes("dji")) return "Wireless";

  return null;
}

// ===== FLOW ENGINE =====
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
      { q: "Brightness > 0? (Display Control)", yes: "done", no: "fix_output" }
    ];
  }

  if (device === "PTZ") {
    return [
      { q: "Camera powered and on network?", yes: 1, no: "fix_power" },
      { q: "Controller sees camera?", yes: 2, no: "fix_network" },
      { q: "Camera moves?", yes: 3, no: "fix_control" },
      { q: "Video output connected?", yes: "done", no: "fix_output" }
    ];
  }

  if (device === "Wireless") {
    return [
      { q: "Transmitter powered + input present?", yes: 1, no: "fix_input" },
      { q: "Receiver paired?", yes: 2, no: "fix_pairing" },
      { q: "Signal strength OK?", yes: 3, no: "fix_rf" },
      { q: "Output connected?", yes: "done", no: "fix_output" }
    ];
  }

  return [
    { q: "Is source outputting signal?", yes: 1, no: "fix_input" },
    { q: "Is signal reaching next device?", yes: 2, no: "fix_cable" },
    { q: "Is output device correct?", yes: "done", no: "fix_output" }
  ];
}

// ===== FIX RESPONSES =====
function getFix(action) {
  const fixes = {
    fix_input: "🔧 Check source output and input selection.",
    fix_routing: "🔧 Check routing configuration.",
    fix_layer: "🔧 Ensure layer is visible.",
    fix_output: "🔧 Check display input/source.",
    fix_mapping: "🔧 Verify LED mapping.",
    fix_pairing: "🔧 Re-pair TX/RX.",
    fix_rf: "🔧 Check interference/signal strength.",
    fix_power: "🔧 Check power supply.",
    fix_network: "🔧 Check IP/network config.",
    fix_control: "🔧 Check controller assignment.",
    fix_cable: "🔧 Check cables."
  };

  return fixes[action];
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
slackApp.event('message', async ({ event, say, client }) => {
  try {
    if (event.bot_id || event.subtype) return;

    const channelInfo = await client.conversations.info({ channel: event.channel });
    if (channelInfo.channel.name !== process.env.HELP_CHANNEL) return;

    const eventKey = `event:${event.ts}`;
    if (await redis.get(eventKey)) return;
    await redis.set(eventKey, "1", "EX", 60);

    const threadTs = event.thread_ts || event.ts;
    const text = event.text.toLowerCase();

    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes'
    }).catch(() => {});

    const flowState = await getFlowState(threadTs);

    // ===== START FLOW =====
    if (!flowState) {
      const device = detectDevice(text);
      const steps = getFlow(device);

      await saveFlowState(threadTs, { step: 0, steps });

      await say({
        thread_ts: threadTs,
        text: `🔍 Starting troubleshooting (${device || "system"})\n\n${steps[0].q}`
      });

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
      return;
    }

    if (next === "done") {
      await say({
        thread_ts: threadTs,
        text: "✅ Signal path confirmed. Escalate if still unresolved."
      });

      await clearFlowState(threadTs);
      return;
    }

    flowState.step = next;
    await saveFlowState(threadTs, flowState);

    await say({
      thread_ts: threadTs,
      text: flowState.steps[next].q
    });

  } catch (err) {
    console.error(err);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🚀 Lux AV Help Desk running`);
});