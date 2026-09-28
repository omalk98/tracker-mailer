import { Schema, model, models } from "mongoose";

const locationFields = {
  city: String,
  regionName: String,
  country: String,
  countryCode: String,
  continent: String,
  zip: String,
  timezone: String,
  lat: Number,
  lon: Number,
};

const VisitorSchema = new Schema({
  visitorId: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, required: true },
  lastSeen: { type: Date, required: true },
  sessionCount: { type: Number, default: 0 },
  initialIp: String,
  initialLocation: locationFields,
});

const SessionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  visitorId: { type: String, index: true },
  startedAt: { type: Date, required: true },
  lastActivity: { type: Date, required: true, index: true },
  classification: {
    type: String,
    enum: ["human", "bot", "crawler"],
    required: true,
  },
  ip: String,
  userAgent: String,
  client: Schema.Types.Mixed,
  context: Schema.Types.Mixed,
  location: locationFields,
  network: {
    isp: String,
    org: String,
    as: String,
    mobile: Boolean,
    proxy: Boolean,
    hosting: Boolean,
  },
});

const EventSchema = new Schema({
  visitorId: { type: String, index: true },
  sessionId: { type: String, required: true, index: true },
  type: { type: String, required: true, index: true },
  page: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  metadata: Schema.Types.Mixed,
});

const IpEnrichmentSchema = new Schema({
  ip: { type: String, required: true, unique: true, index: true },
  data: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const LegacyIpSchema = new Schema(
  {
    country: String,
    countryCode: String,
    coordinates: { lat: Number, lon: Number },
  },
  { collection: "ips" }
);

export const Visitor = models.Visitor || model("Visitor", VisitorSchema);
export const Session = models.Session || model("Session", SessionSchema);
export const Event = models.Event || model("Event", EventSchema);
export const IpEnrichment =
  models.IpEnrichment || model("IpEnrichment", IpEnrichmentSchema);
export const LegacyIp = models.LegacyIp || model("LegacyIp", LegacyIpSchema);
