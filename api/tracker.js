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
import { UAParser } from "ua-parser-js";
import { v4 as uuidv4 } from "uuid";

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
  uniqueId: String, // Add reference to unique ID
});

// New schema for tracking unique IDs
const UniqueIDSchema = new Schema({
  uniqueId: { type: String, required: true, unique: true },
  nickname: { type: String, default: "unknown" },
  counter: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  lastAccessed: { type: Date, default: Date.now },
  initialIP: String,
  initialLocation: {
    city: String,
    country: String,
    countryCode: String,
  }
});

const IP_model = model("ip", IPSchema);
const UniqueID_model = model("uniqueid", UniqueIDSchema);

const database = process.env.MONGO_URI;
mongoose_set("strictQuery", true);
mongoose_connect(database).catch((err) => {
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

// Generic authorization middleware
const requireAuth = (req, res, next) => {
  const { authorization } = req.headers;
  if (authorization !== process.env.AUTHORIZATION) {
    console.warn("Unauthorized access attempt");
    res.sendStatus(401);
    return;
  }
  next();
};

// Function to get cached or fresh map data
const getMapData = async () => {
  // Fetch fresh data from database
  const uniqueCountries = await IP_model.aggregate([
    {
      $match: {
        "coordinates.lat": { $exists: true, $ne: null },
        "coordinates.lon": { $exists: true, $ne: null },
        country: { $exists: true, $ne: null }
      }
    },
    {
      $group: {
        _id: "$country",
        lat: { $first: "$coordinates.lat" },
        lon: { $first: "$coordinates.lon" },
        countryCode: { $first: "$countryCode" },
        visitCount: { $sum: 1 }
      }
    },
    {
      $sort: { visitCount: -1 }
    }
  ]);

  // Transform to the requested format
  const referencePoint = { lat: 45.5017, lng: -73.5673 }; // Montreal, Quebec as reference
  
  const mapData = uniqueCountries.map(country => ({
    start: referencePoint,
    end: { 
      lat: country.lat, 
      lng: country.lon 
    },
    country: country._id,
    countryCode: country.countryCode,
    visitCount: country.visitCount
  }));

  return mapData;
};

// Map endpoint to get unique countries with coordinates
router.get("/map", requireAuth, async (req, res) => {
  try {
    // Get data (from server cache or database)
    const mapData = await getMapData();
    
    res.json(mapData);
  } catch (err) {
    console.error("Error fetching map data:", err);
    res.status(500).json({ error: "Failed to fetch map data" });
  }
});

router.get("/{*any}", requireAuth, async (req, res) => {
  try {
    const { authid } = req.headers;
    const timestamp = new Date();
    const ip = req.clientIp.split(":").pop();
    const ip_info = (
      await axios.get(`http://ip-api.com/json/${ip}?fields=18575355`)
    ).data;
    const origin = `${req.get("origin") || req.get("host")}${req.originalUrl}`;
    const flag = `https://flagcdn.com/24x18/${ip_info?.countryCode?.toLowerCase()}.png`;
    const ua = req.get("user-agent");
    const client_info = {
      ip,
      ...ip_info,
      origin,
      flag,
      mobile: ip_info.mobile || ua.match(/mobi|android|iphone/i) !== null,
    };
    const user_agent = UAParser(ua);
    const { lat, lon } = client_info;
    client_info.coordinates = { lat, lon };
    const mapUrl =
      lat && lon
        ? `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=11&size=300x400&maptype=roadmap&markers=color:red%7C${lat},${lon}&key=${process.env.GOOGLE_API_KEY}`
        : "";

    // Check if request has authid header
    let uniqueId = null;
    let isReturningVisitor = false;

    if (authid) {
      // If authid is provided, try to find and update the counter
      const existingUniqueID = await UniqueID_model.findOne({ uniqueId: authid });
      if (existingUniqueID) {
        existingUniqueID.counter += 1;
        existingUniqueID.lastAccessed = timestamp;
        await existingUniqueID.save();
        uniqueId = authid;
        isReturningVisitor = true;
        console.log(`Returning visitor with ID: ${authid}, counter: ${existingUniqueID.counter}`);
      } else {
        console.warn(`Invalid authid provided: ${authid}`);
      }
    } else {
      // No authid provided, check if we should generate a new unique ID
      const isHosting = client_info.hosting;
      const isVPN = client_info.proxy; // Assuming proxy indicates VPN
      
      if (!isHosting && !isVPN) {
        // Generate new unique ID
        uniqueId = uuidv4();
        
        // Create new unique ID record
        await UniqueID_model.create({
          uniqueId,
          nickname: "unknown",
          counter: 1,
          createdAt: timestamp,
          lastAccessed: timestamp,
          initialIP: ip,
          initialLocation: {
            city: client_info.city,
            country: client_info.country,
            countryCode: client_info.countryCode,
          }
        });
        
        console.log(`New unique ID generated: ${uniqueId} for IP: ${ip}`);
      } else {
        console.log(`Skipping unique ID generation - hosting: ${isHosting}, VPN/proxy: ${isVPN}`);
      }
    }

    const existingRecord = await IP_model.findOne({
      ip: ip,
      timestamp: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    });
    
    // Create IP record with unique ID reference
    await IP_model.create({ 
      ...client_info, 
      ...user_agent, 
      timestamp,
      uniqueId: uniqueId || undefined // Only add if uniqueId exists
    });

    if (existingRecord) {
      console.warn("IP visited within the last 10 minutes");
      res.sendStatus(200);
      return;
    }

    const html = readFileSync(
      join(__dirname, "../public", "email.hbs"),
      "utf-8"
    );
    const compiled = hb.compile(html);

    // Get unique ID info for email if available
    let uniqueIdInfo = null;
    if (uniqueId) {
      uniqueIdInfo = await UniqueID_model.findOne({ uniqueId });
    }

    const email_content = compiled({
      ...client_info,
      ...user_agent,
      timestamp: timestamp.toLocaleString("en-US", date_options),
      mapUrl,
      uniqueId,
      isReturningVisitor,
      uniqueIdInfo,
    });

    const subjectPrefix = isReturningVisitor ? "Returning" : "New";
    const subjectSuffix = uniqueId ? ` (ID: ${uniqueId.substring(0, 8)}...)` : "";
    
    const info = await transporter.sendMail({
      from: sender_email,
      to: receiver_email,
      subject: `${subjectPrefix} Website Visitor from ${client_info?.city}, ${client_info?.country}${subjectSuffix}`,
      html: email_content,
    });

    console.log("Email sent:", "accepted: ", info.accepted, "rejected: ", info.rejected, "response: ", info.response);

    console.log("Email sent successfully");
    
    // Return the unique ID to the client if generated
    const responseData = uniqueId && !isReturningVisitor ? { uniqueId } : {};
    res.status(200).json(responseData);
    
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

//
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express_ip());
app.use(router);

export default app;