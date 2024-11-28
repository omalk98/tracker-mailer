import { config as env_config } from "dotenv";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Schema, model } from "mongoose";
import cors from "cors";
import { connect as mongoose_connect, set as mongoose_set } from "mongoose";
import axios from "axios";
import hb from "handlebars";
import { createTransport } from "nodemailer";
import { mw as express_ip } from "request-ip";
import ua_parser from "ua-parser-js";

// START General Setup
env_config();

// Database setup
const CoordinatesSchema = new Schema({
  lat: Number,
  lon: Number,
});
const DeviceSchema = new Schema({
  model: String,
  type: String,
  vendor: String,
});
const OSSchema = new Schema({
  name: String,
  version: String,
});
const BrowserSchema = new Schema({
  name: String,
  version: String,
  major: String,
});
const EngineSchema = new Schema({
  name: String,
  version: String,
});
const CPUSchema = new Schema({
  architecture: String,
});

const IPSchema = new Schema({
  ip: { type: String, required: true, immutable: true },
  timestamp: {
    type: Date,
    required: true,
    immutable: true,
  },
  district: String,
  city: String,
  regionName: String,
  country: String,
  countryCode: String,
  continent: String,
  zip: String,
  isp: String,
  org: String,
  as: String,
  mobile: Boolean,
  proxy: Boolean,
  hosting: Boolean,
  origin: String,
  ua: String,
  coordinates: {
    type: CoordinatesSchema,
  },
  os: {
    type: OSSchema,
  },
  browser: {
    type: BrowserSchema,
  },
  engine: {
    type: EngineSchema,
  },
  device: {
    type: DeviceSchema,
  },
  cpu: {
    type: CPUSchema,
  },
});
const IP_model = model("ip", IPSchema);
const database = process.env.MONGO_URI;
mongoose_set("strictQuery", true);
mongoose_connect(database, {
  useUnifiedTopology: true,
  useNewUrlParser: true,
}).catch((err) => {
  throw new Error(err);
});

// Mailer setup
const sender_email = process.env.SENDER_EMAIL;
const sender_password = process.env.SENDER_PASSWORD;
const receiver_email = process.env.RECEIVER_EMAIL;
const transporter = createTransport({
  service: "gmail",
  auth: {
    user: sender_email,
    pass: sender_password,
  },
});

// Handlebars setup
hb.registerHelper("ifAnd", function (v1, v2, options) {
  if (v1 && v2) {
    return options.fn(this);
  }
  return options.inverse(this);
});
hb.registerHelper("ifOr", function (v1, v2, v3, options) {
  if (v1 || v2 || v3) {
    return options.fn(this);
  }
  return options.inverse(this);
});

// Server setup
const date_options = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  timeZone: "America/Toronto",
};
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const router = express.Router();

// END General Setup

router.get("*", async (req, res) => {
  try {
    const { authorization } = req.headers;
    if (authorization !== process.env.AUTHORIZATION) {
      console.warn("Unauthorized access attempt");
      res.sendStatus(401);
      return;
    }

    const timestamp = new Date();
    const ip = req.clientIp.split(":").pop();
    const ip_info = (
      await axios.get(`http://ip-api.com/json/${ip}?fields=18575355`)
    ).data;
    const origin = `${req.get("origin") || req.get("host")}${req.originalUrl}`;
    const flag = `https://flagcdn.com/24x18/${ip_info?.countryCode?.toLowerCase()}.png`;
    const client_info = {
      ip,
      ...ip_info,
      origin,
      flag,
    };
    const user_agent = ua_parser(req.get("user-agent"));
    const { lat, lon } = client_info;
    client_info.coordinates = { lat, lon };
    const mapUrl =
      lat && lon
        ? `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=11&size=300x400&maptype=roadmap&markers=color:red%7C${lat},${lon}&key=${process.env.GOOGLE_API_KEY}`
        : "";

    await IP_model.create({ ...client_info, ...user_agent, timestamp });

    const html = readFileSync(
      join(__dirname, "../public", "email.hbs"),
      "utf-8"
    );
    const compiled = hb.compile(html);

    const existingRecord = await IP_model.findOne({
      ip: ip,
      timestamp: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    });

    if (existingRecord) {
      console.warn("IP visited within the last 10 minutes");
      res.sendStatus(200);
      return;
    }

    const email_content = compiled({
      ...client_info,
      ...user_agent,
      timestamp: timestamp.toLocaleString("en-US", date_options),
      mapUrl,
    });

    await transporter.sendMail({
      from: sender_email,
      to: receiver_email,
      subject: `New Website Visitor from ${client_info?.city}, ${client_info?.country}!`,
      html: email_content,
    });

    console.log("Email sent successfully");
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express_ip());
app.use(router);

export default app;
