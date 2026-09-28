import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import Handlebars from "handlebars";
import mongoose from "mongoose";
import { createTransport } from "nodemailer";
import { UAParser } from "ua-parser-js";
import { Event, IpEnrichment, LegacyIp, Session, Visitor } from "./models.js";
import { canResumeSession, classifyUserAgent, eventSchema, mergeCountryRows, normalizeIp, shouldNotify } from "./tracking.js";

loadEnv();
mongoose.set("strictQuery", true);
mongoose.connect(process.env.MONGO_URI).catch((error) => console.error("MongoDB connection failed:", error));

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "16kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));

const transporter = createTransport({
  service: "gmail",
  auth: { user: process.env.SENDER_EMAIL, pass: process.env.SENDER_PASSWORD },
});
const template = Handlebars.compile(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/email.hbs"), "utf8"));

function requireAuth(req, res, next) {
  if (req.get("authorization") !== process.env.AUTHORIZATION) return res.sendStatus(401);
  next();
}

async function enrichIp(ip) {
  if (!ip) return {};
  const cached = await IpEnrichment.findOne({ ip, expiresAt: { $gt: new Date() } }).lean();
  if (cached) return cached.data;
  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=18575355`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return {};
    const data = await response.json();
    if (data.status === "fail") return {};
    await IpEnrichment.findOneAndUpdate(
      { ip },
      { ip, data, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      { upsert: true }
    );
    return data;
  } catch (error) {
    console.warn("IP enrichment failed:", error.message);
    return {};
  }
}

async function resolveVisitor(visitorId, timestamp, ip, location) {
  if (visitorId) {
    const visitor = await Visitor.findOneAndUpdate({ visitorId }, { lastSeen: timestamp }, { new: true });
    if (visitor) return visitor;
  }
  return Visitor.create({
    visitorId: randomUUID(), createdAt: timestamp, lastSeen: timestamp,
    sessionCount: 0, initialIp: ip, initialLocation: location,
  });
}

async function resolveSession({ sessionId, visitorId, timestamp, classification, ip, userAgent, client, context, enrichment }) {
  if (sessionId) {
    const session = await Session.findOne({ sessionId });
    if (session && session.visitorId === visitorId && canResumeSession(session.lastActivity, timestamp)) {
      session.lastActivity = timestamp;
      await session.save();
      return { session, isNewSession: false };
    }
  }
  const session = await Session.create({
    sessionId: randomUUID(), visitorId, startedAt: timestamp, lastActivity: timestamp,
    classification, ip, userAgent, client, context, location: enrichment, network: enrichment,
  });
  if (visitorId) await Visitor.updateOne({ visitorId }, { $inc: { sessionCount: 1 } });
  return { session, isNewSession: true };
}

async function sendSummary({ visitor, session, event }) {
  const events = await Event.find({ sessionId: session.sessionId }).sort({ occurredAt: 1 }).lean();
  await transporter.sendMail({
    from: process.env.SENDER_EMAIL,
    to: process.env.RECEIVER_EMAIL,
    subject: `${event.type === "page_view" ? "New" : "Updated"} portfolio session from ${session.location?.city || "unknown location"}`,
    html: template({ visitor: visitor?.toObject(), session: session.toObject(), events }),
  });
}

app.get("/map", requireAuth, async (_req, res) => {
  try {
    const group = (prefix) => {
      const isSession = prefix === "location";
      return [
      { $match: {
        ...(isSession ? { classification: "human" } : {}),
        [isSession ? "location.countryCode" : "countryCode"]: { $nin: [null, ""] },
        [`${prefix}.lat`]: { $ne: null },
        [`${prefix}.lon`]: { $ne: null },
      } },
      { $group: {
        _id: `$${isSession ? "location.countryCode" : "countryCode"}`,
        lat: { $avg: `$${prefix}.lat` },
        lng: { $avg: `$${prefix}.lon` },
        visitCount: { $sum: 1 },
      } },
      { $project: { _id: 0, countryCode: "$_id", lat: 1, lng: 1, visitCount: 1 } },
    ];
    };
    const [sessions, legacy] = await Promise.all([
      Session.aggregate(group("location")), LegacyIp.aggregate(group("coordinates")),
    ]);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.json(mergeCountryRows([...legacy, ...sessions]));
  } catch (error) {
    console.error("Map query failed:", error);
    res.status(500).json({ error: "Failed to fetch map data" });
  }
});

app.post("/events", requireAuth, async (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid event", details: parsed.error.issues });
  try {
    const data = parsed.data;
    const timestamp = new Date();
    const userAgent = req.get("user-agent") || "";
    const client = UAParser(userAgent);
    const classification = classifyUserAgent(userAgent);
    const ip = normalizeIp(req.ip);
    const enrichment = await enrichIp(ip);
    const visitor = classification === "human"
      ? await resolveVisitor(data.visitorId, timestamp, ip, enrichment)
      : null;
    const { session, isNewSession } = await resolveSession({
      sessionId: data.sessionId, visitorId: visitor?.visitorId, timestamp, classification,
      ip, userAgent, client, context: data.context, enrichment,
    });
    const event = await Event.create({
      visitorId: visitor?.visitorId, sessionId: session.sessionId, type: data.type,
      page: data.page, occurredAt: new Date(data.occurredAt), receivedAt: timestamp, metadata: data.metadata,
    });
    if (shouldNotify({ classification, isNewSession, type: data.type })) {
      try {
        await sendSummary({ visitor, session, event });
      } catch (error) {
        console.error("Session notification failed:", error);
      }
    }
    res.status(201).json({ visitorId: visitor?.visitorId, sessionId: session.sessionId });
  } catch (error) {
    console.error("Event tracking failed:", error);
    res.status(500).json({ error: "Failed to track event" });
  }
});

export default app;
