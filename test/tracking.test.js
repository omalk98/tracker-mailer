import test from "node:test";
import assert from "node:assert/strict";

import {
  canResumeSession,
  classifyUserAgent,
  eventSchema,
  mergeCountryRows,
  normalizeIp,
  shouldNotify,
} from "../api/tracking.js";

test("normalizeIp preserves IPv6 and unwraps IPv4-mapped IPv6", () => {
  assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
});

test("mergeCountryRows returns compact country coordinates and combined counts", () => {
  assert.deepEqual(
    mergeCountryRows([
      { countryCode: "CA", lat: 45, lng: -75, visitCount: 2 },
      { countryCode: "CA", lat: 55, lng: -95, visitCount: 3 },
      { countryCode: "US", lat: 39, lng: -98, visitCount: 1 },
    ]),
    [
      { countryCode: "CA", lat: 51, lng: -87, visitCount: 5 },
      { countryCode: "US", lat: 39, lng: -98, visitCount: 1 },
    ]
  );
});

test("classifyUserAgent separates crawlers and other bots from humans", () => {
  assert.equal(classifyUserAgent("Mozilla/5.0 Chrome/130 Safari/537.36"), "human");
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), "crawler");
  assert.equal(classifyUserAgent("curl/8.7.1"), "bot");
});

test("shouldNotify only accepts meaningful human activity", () => {
  assert.equal(shouldNotify({ classification: "human", isNewSession: true, type: "page_view" }), true);
  assert.equal(shouldNotify({ classification: "human", isNewSession: false, type: "resume_download" }), true);
  assert.equal(shouldNotify({ classification: "human", isNewSession: false, type: "contact_submit" }), true);
  assert.equal(shouldNotify({ classification: "human", isNewSession: false, type: "page_view" }), false);
  assert.equal(shouldNotify({ classification: "crawler", isNewSession: true, type: "resume_download" }), false);
});

test("eventSchema rejects unknown fields and invalid event types", () => {
  const event = {
    type: "page_view",
    page: "https://omalk98.com/",
    occurredAt: "2026-09-27T20:00:00.000Z",
    context: {
      viewport: { width: 1440, height: 900 },
      language: "en-CA",
      timezone: "America/Toronto",
    },
  };

  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, type: "keypress" }).success, false);
  assert.equal(eventSchema.safeParse({ ...event, fingerprint: "nope" }).success, false);
});

test("canResumeSession expires sessions after 30 minutes", () => {
  const now = new Date("2026-09-27T20:30:00.000Z");
  assert.equal(canResumeSession(new Date("2026-09-27T20:00:01.000Z"), now), true);
  assert.equal(canResumeSession(new Date("2026-09-27T20:00:00.000Z"), now), false);
});
