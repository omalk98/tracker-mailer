import { config as env_config } from 'dotenv';
import { readFileSync } from 'fs';
import express from 'express';
import cors from 'cors';
import { connect as mongoose_connect, set as mongoose_set } from 'mongoose';
import axios from 'axios';
import handlebars from 'handlebars';
import { createTransport } from 'nodemailer';
import { mw as express_ip } from 'request-ip';
import { express as express_useragent } from 'express-useragent';
import { Schema, model } from 'mongoose';

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

env_config();

const database = process.env.MONGO_URI;
mongoose_set('strictQuery', true);
mongoose_connect(database, {
  useUnifiedTopology: true,
  useNewUrlParser: true
}).catch((err) => {
  throw new Error(err);
});

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express_ip());
app.use(express_useragent());

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

const date_options = {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  timeZone: 'America/Toronto'
};

app.get('*', async (req, res) => {
  try {
    const timestamp = new Date();
    const ip = req.clientIp.split(':').pop();
    const client_info = (
      await axios.get(`http://ip-api.com/json/${ip}?fields=18573305`)
    ).data;
    const user_agent = req.useragent;
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${client_info?.lat},${client_info?.lon}&zoom=11&size=300x400&maptype=roadmap&markers=color:red%7C${client_info?.lat},${client_info?.lon}&key=${process.env.GOOGLE_API_KEY}`; //&signature=YOUR_SIGNATURE`;

    await IP_model.create({ ip, timestamp });
    const html = readFileSync('./tracker/email.hbs', 'utf-8');
    const compiled = handlebars.compile(html);
    const email_content = compiled({
      ...client_info,
      ...user_agent,
      timestamp: timestamp.toLocaleString('en-US', date_options),
      mapUrl
    });

    await transporter.sendMail({
      from: sender_email,
      to: receiver_email,
      subject: `New Website Visitor from ${client_info?.regionName}, ${client_info?.country}!`,
      html: email_content
    });
  } catch (err) {
    console.error(err);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {});
