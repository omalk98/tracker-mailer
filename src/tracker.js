import { config as env_config } from 'dotenv';
import { readFileSync } from 'fs';
import express from 'express';
import { Schema, model } from 'mongoose';
import cors from 'cors';
import { connect as mongoose_connect, set as mongoose_set } from 'mongoose';
import axios from 'axios';
import hb from 'handlebars';
import { createTransport } from 'nodemailer';
import { mw as express_ip } from 'request-ip';
import { express as express_useragent } from 'express-useragent';
import { capture as express_device } from 'express-device';

// START General Setup
env_config();

// Database setup
const IPSchema = new Schema({
  ip: { type: String, unique: true, required: true, immutable: true },
  timestamp: {
    type: Date,
    required: true,
    immutable: true,
    expires: 60 * 60
  }
});
const IP_model = model('ip', IPSchema);
const database = process.env.MONGO_URI;
mongoose_set('strictQuery', true);
mongoose_connect(database, {
  useUnifiedTopology: true,
  useNewUrlParser: true
}).catch((err) => {
  throw new Error(err);
});

// Mailer setup
const sender_email = process.env.SENDER_EMAIL;
const sender_password = process.env.SENDER_PASSWORD;
const receiver_email = process.env.RECEIVER_EMAIL;
const transporter = createTransport({
  service: 'gmail',
  auth: {
    user: sender_email,
    pass: sender_password
  }
});

// Handlebars setup
hb.registerHelper('ifAnd', function (v1, v2, options) {
  if (v1 && v2) {
    return options.fn(this);
  }
  return options.inverse(this);
});
hb.registerHelper('ifOr', function (v1, v2, options) {
  if (v1 || v2) {
    return options.fn(this);
  }
  return options.inverse(this);
});

// Server setup
const date_options = {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  timeZone: 'America/Toronto'
};
const app = express();
const router = express.Router();

// END General Setup

router.get('*', async (req, res) => {
  try {
    const { authorization } = req.headers;
    if (authorization !== process.env.AUTHORIZATION) {
      res.sendStatus(401);
      return;
    }

    const timestamp = new Date();
    const ip = req.clientIp.split(':').pop();
    const ip_info = (
      await axios.get(`http://ip-api.com/json/${ip}?fields=18575355`)
    ).data;
    const origin = req.get('origin') || req.get('host');
    const flag = `https://flagcdn.com/24x18/${ip_info?.countryCode.toLowerCase()}.png`;
    const client_info = {
      ...ip_info,
      origin,
      flag
    };
    const { type, name } = req.device;
    const user_agent = { ...req.useragent, type, name };
    const { lat, lon } = client_info;
    const mapUrl =
      lat && lon
        ? `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=11&size=300x400&maptype=roadmap&markers=color:red%7C${lat},${lon}&key=${process.env.GOOGLE_API_KEY}`
        : '';

    await IP_model.create({ ip, timestamp });

    const html = readFileSync('./src/email.hbs', 'utf-8');
    const compiled = hb.compile(html);
    const email_content = compiled({
      ...client_info,
      ...user_agent,
      timestamp: timestamp.toLocaleString('en-US', date_options),
      mapUrl
    });

    await transporter.sendMail({
      from: sender_email,
      to: receiver_email,
      subject: `New Website Visitor from ${client_info?.city}, ${client_info?.country}!`,
      html: email_content
    });
  } catch (err) {
    console.error(err);
  }
  res.sendStatus(200);
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express_ip());
app.use(express_useragent());
app.use(express_device());
app.use(router);

export default app;
