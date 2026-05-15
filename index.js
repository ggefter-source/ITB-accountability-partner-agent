/**
 * Gabriel's Accountability Agent
 * --------------------------------
 * - 8:00 AM Mon–Sat: morning check-in via SMS
 * - Parses reply → creates Google Calendar event
 * - At committed time: accountability check
 * - No reply in 5 min → fires motivational message (one fear or reward, never both)
 *
 * Required env vars (set in Railway/Render dashboard):
 *   ANTHROPIC_API_KEY
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER   (your Twilio number, e.g. +15550001234)
 *   GABRIEL_PHONE_NUMBER  (your personal number, e.g. +15559876543)
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   PORT                  (optional, defaults to 3000)
 */

import express from "express";
import cron from "node-cron";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { addMinutes, format, parse, isValid } from "date-fns";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Clients ────────────────────────────────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ─── Gabriel's profile ──────────────────────────────────────────────────────

const GABRIEL = {
  fears: [
    "wasting the limited time you have on things that won't fulfil you or build real memories",
    "avoiding your purpose and slowly eroding the depth of your personal connections",
    "financial insecurity — no fuck-you money, becoming a literal slave if the world turns",
    "the constant feeling of having no control over your own life",
    "being unhealthy, not fixing what's broken now, and creating worse problems through avoidance",
    "spending your life doing meaningless work just to survive",
    "lying on your deathbed stacked with regrets",
    "filling the boredom hole with bullshit entertainment instead of building something real",
    "seeing the patterns clearly but never taking enough action to break them",
    "dying like your grandfathers — alone, no sovereignty, surrounded by people who don't love them, slowly fading, dreading every day",
  ],
  rewards: [
    "travel — being somewhere completely new, fully alive, on your own terms",
    "a course or retreat that reshapes how you see the world",
    "the BMW in the driveway — not just the car, what it means you built",
    "the deep satisfaction of real rest that you actually earned",
    "that moment when the ball drops on a project and everything flows — pure momentum",
  ],
};

// ─── State (in-memory; persists for the life of the process) ────────────────

/**
 * pendingCommitments[gabrielPhone] = {
 *   task: string,
 *   time: Date,
 *   checkInJobId: string | null,
 *   checkedIn: boolean
 * }
 */
const pendingCommitments = {};

// conversation history for morning check-in multi-turn
let morningConversation = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendSMS(to, body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
}

async function claudeChat(messages, systemPrompt) {
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });
  return res.content[0].text.trim();
}

async function createCalendarEvent(task, startTime) {
  const endTime = addMinutes(startTime, 90);
  const event = {
    summary: `🎯 ${task}`,
    description: "Created by your accountability agent.",
    start: { dateTime: startTime.toISOString(), timeZone: "America/Montreal" },
    end: { dateTime: endTime.toISOString(), timeZone: "America/Montreal" },
    colorId: "5", // banana yellow — stands out
  };
  const res = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
  });
  return res.data;
}

/**
 * Parse a time string from a message like "at 10am", "10:30", "2 PM" etc.
 * Returns a Date for today at that time, or null if unparseable.
 */
async function parseCommitmentFromReply(replyText) {
  const today = format(new Date(), "yyyy-MM-dd");
  const prompt = `Extract the task name and the start time from this message. 
Reply with ONLY valid JSON like: {"task":"finish client proposal","time":"10:00"}
Use 24-hour time. If no clear time is given, use null.
Message: "${replyText}"`;

  const raw = await claudeChat(
    [{ role: "user", content: prompt }],
    "You are a JSON extractor. Output only JSON, no markdown, no explanation."
  );

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!parsed.task || !parsed.time) return null;

    const dt = parse(
      `${today} ${parsed.time}`,
      "yyyy-MM-dd HH:mm",
      new Date()
    );
    if (!isValid(dt)) return null;
    return { task: parsed.task, time: dt };
  } catch {
    return null;
  }
}

// ─── Motivational message generator ────────────────────────────────────────

async function generateMotivation(context) {
  // Pick EXACTLY one item — alternates between fears and rewards randomly
  const useFear = Math.random() > 0.4; // 60% fear, 40% reward (fears hit harder)
  const theme = useFear ? pickOne(GABRIEL.fears) : pickOne(GABRIEL.rewards);
  const type = useFear ? "fear" : "reward";

  const system = `You are Gabriel's personal accountability agent. You know him deeply.
You send one SMS when he goes quiet after committing to a task.

Rules:
- Focus on ONE thing only: "${theme}"
- If it's a fear: make it visceral and real — not mean, but honest. Make him feel the cost of inaction.
- If it's a reward: paint the picture vividly. Make him want it badly enough to move.
- 2-4 sentences max. No fluff. No generic hustle content. No emojis.
- Sound like a trusted person who genuinely gives a damn, not a motivational poster.
- Never mention the other fears or rewards. One thing, fully.`;

  const userMsg = `Gabriel committed to: "${context.task}" at ${format(context.time, "h:mm a")}.
He hasn't responded. Send the message. Focus: ${type} — "${theme}"`;

  return claudeChat([{ role: "user", content: userMsg }], system);
}

// ─── Morning check-in flow ──────────────────────────────────────────────────

async function sendMorningCheckIn() {
  morningConversation = [];
  const msg =
    "Morning Gabriel. What's the most important thing you need to get done today — and what time are you going to start it?";
  morningConversation.push({ role: "assistant", content: msg });
  await sendSMS(process.env.GABRIEL_PHONE_NUMBER, msg);
  console.log(`[${new Date().toISOString()}] Morning check-in sent`);
}

// ─── Handle incoming SMS from Gabriel ──────────────────────────────────────

app.post("/sms/incoming", async (req, res) => {
  res.sendStatus(200); // respond to Twilio immediately

  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const phone = process.env.GABRIEL_PHONE_NUMBER;

  if (from !== phone) return; // ignore unknown senders

  console.log(`[${new Date().toISOString()}] SMS from Gabriel: "${body}"`);

  const state = pendingCommitments[phone];

  // ── Case 1: awaiting morning commitment reply ──
  if (morningConversation.length > 0 && (!state || !state.checkedIn)) {
    morningConversation.push({ role: "user", content: body });

    const parsed = await parseCommitmentFromReply(body);

    if (parsed) {
      // We have task + time — create calendar event
      try {
        await createCalendarEvent(parsed.task, parsed.time);
      } catch (err) {
        console.error("Calendar error:", err.message);
      }

      const confirmMsg = `Done — I've blocked ${format(parsed.time, "h:mm a")} in your calendar: "${parsed.task}". I'll check in with you then.`;
      morningConversation.push({ role: "assistant", content: confirmMsg });
      await sendSMS(phone, confirmMsg);

      // Schedule accountability check at committed time
      pendingCommitments[phone] = {
        task: parsed.task,
        time: parsed.time,
        checkedIn: false,
      };
      scheduleAccountabilityCheck(phone, parsed);
      morningConversation = []; // done with morning flow
    } else {
      // Claude asks for clarification
      const clarify = await claudeChat(
        morningConversation,
        `You are Gabriel's accountability agent via SMS. He needs to tell you his most important task and what time he'll start it.
He hasn't given you a clear time yet. Ask once, briefly. Max 1 sentence.`
      );
      morningConversation.push({ role: "assistant", content: clarify });
      await sendSMS(phone, clarify);
    }
    return;
  }

  // ── Case 2: accountability check reply ──
  if (state && !state.checkedIn) {
    state.checkedIn = true;
    const affirmations = [
      "Let's go. Make it count.",
      "Good. Now close everything else.",
      "That's what I want to hear. Lock in.",
    ];
    await sendSMS(phone, pickOne(affirmations));
  }
});

// ─── Accountability check scheduler ─────────────────────────────────────────

function scheduleAccountabilityCheck(phone, commitment) {
  const { task, time } = commitment;
  const now = new Date();
  const delay = time - now;

  if (delay <= 0) return; // time already passed

  console.log(
    `[${new Date().toISOString()}] Scheduling accountability check for ${format(time, "h:mm a")} — "${task}"`
  );

  setTimeout(async () => {
    const state = pendingCommitments[phone];
    if (!state || state.checkedIn) return;

    const checkMsg = `It's ${format(time, "h:mm a")} — are you on "${task}"?`;
    await sendSMS(phone, checkMsg);
    console.log(`[${new Date().toISOString()}] Accountability check sent`);

    // Wait 5 minutes for reply
    setTimeout(async () => {
      const s = pendingCommitments[phone];
      if (!s || s.checkedIn) return;

      console.log(
        `[${new Date().toISOString()}] No reply — generating motivational message`
      );
      const motivation = await generateMotivation({ task, time });
      await sendSMS(phone, motivation);
    }, 5 * 60 * 1000); // 5 minutes
  }, delay);
}

// ─── Cron: 8:00 AM Mon–Sat (Montreal / Eastern time) ───────────────────────
// Cron runs in server local time. If you deploy to Railway, set TZ=America/Montreal
// in your environment variables.

cron.schedule(
  "0 8 * * 1-6",
  () => {
    sendMorningCheckIn().catch(console.error);
  },
  { timezone: "America/Montreal" }
);

// ─── Manual trigger endpoint (for testing) ──────────────────────────────────

app.post("/trigger/morning", async (req, res) => {
  await sendMorningCheckIn();
  res.json({ ok: true, message: "Morning check-in triggered" });
});

app.post("/trigger/motivation-test", async (req, res) => {
  const msg = await generateMotivation({
    task: "test task",
    time: new Date(),
  });
  await sendSMS(process.env.GABRIEL_PHONE_NUMBER, msg);
  res.json({ ok: true, message: msg });
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gabriel's accountability agent running on port ${PORT}`);
  console.log(`Timezone: America/Montreal`);
  console.log(`Check-in schedule: 8:00 AM Mon–Sat`);
});
