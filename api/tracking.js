import { isIP } from "node:net";
import { isbot } from "isbot";
import { z } from "zod";

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const eventSchema = z.strictObject({
  visitorId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  type: z.enum([
    "page_view",
    "project_view",
    "resume_download",
    "github_click",
    "linkedin_click",
    "contact_submit",
  ]),
  page: z.string().max(2048),
  occurredAt: z.iso.datetime(),
  context: z.strictObject({
    viewport: z.strictObject({
      width: z.number().int().nonnegative().max(20000),
      height: z.number().int().nonnegative().max(20000),
    }),
    language: z.string().max(64),
    timezone: z.string().max(128),
    referrer: z.string().max(2048).optional(),
    utm: z
      .strictObject({
        source: z.string().max(256).optional(),
        medium: z.string().max(256).optional(),
        campaign: z.string().max(256).optional(),
        term: z.string().max(256).optional(),
        content: z.string().max(256).optional(),
      })
      .optional(),
  }),
  metadata: z
    .strictObject({
      project: z.string().max(256).optional(),
    })
    .optional(),
});

export function normalizeIp(value = "") {
  const ip = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(ip) ? ip : "";
}

export function classifyUserAgent(userAgent = "") {
  if (!isbot(userAgent)) return "human";
  return /bot|crawl|spider|slurp|bingpreview/i.test(userAgent)
    ? "crawler"
    : "bot";
}

export function shouldNotify({ classification, isNewSession, type }) {
  return (
    classification === "human" &&
    (isNewSession || type === "resume_download" || type === "contact_submit")
  );
}

export function canResumeSession(lastActivity, now = new Date()) {
  return now.getTime() - lastActivity.getTime() < SESSION_TIMEOUT_MS;
}

export function mergeCountryRows(rows) {
  const countries = new Map();
  for (const row of rows) {
    if (!row.countryCode || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    const code = row.countryCode.toUpperCase();
    const current = countries.get(code) || { visits: 0, latTotal: 0, lngTotal: 0 };
    current.visits += row.visitCount;
    current.latTotal += row.lat * row.visitCount;
    current.lngTotal += row.lng * row.visitCount;
    countries.set(code, current);
  }
  return [...countries.entries()]
    .map(([countryCode, value]) => ({
      countryCode,
      lat: value.latTotal / value.visits,
      lng: value.lngTotal / value.visits,
      visitCount: value.visits,
    }))
    .sort((a, b) => b.visitCount - a.visitCount || a.countryCode.localeCompare(b.countryCode));
}
