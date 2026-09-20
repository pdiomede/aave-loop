/**
 * Settings that live in a file rather than in the shell.
 *
 * The ledger has always read its knobs straight off `process.env`, which is
 * right for a port or a database path: they change per run and belong to
 * whoever starts the process. A Telegram bot token is not that. It is a
 * long lived secret that has to survive a reboot, so it goes in `config.env`
 * next to this file and is read once at startup.
 *
 * `process.env` still wins. Every other setting in this project can be
 * overridden by exporting it before `npm start`, and this must not be the one
 * exception, or testing a second group means editing the file each time.
 *
 * Nothing here can stop the app: a missing file, an unreadable one or a
 * half filled one all resolve to "not configured". The ledger is a ledger
 * first and an alarm clock second.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MYAAVE_CONFIG || path.join(root, 'config.env');

/**
 * KEY=value, one per line. `#` comments, blank lines and a leading `export `
 * are tolerated because people paste these in from a shell. The split is on
 * the first `=` only, so a value containing one survives, and a single
 * matching pair of surrounding quotes is stripped.
 *
 * Deliberately not a dotenv: no interpolation, no escapes, no multi-line. A
 * bot token has none of those in it, and every feature here is a way to read a
 * secret wrong.
 */
function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readFile() {
  try {
    return parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    // ENOENT is the ordinary case: most installs never send anything.
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${path.basename(FILE)}: ${err.message}`);
    }
    return null;
  }
}

// Read once. The file cannot change without a restart, and re-reading it per
// poll would be a syscall a minute for a file nobody is editing.
const fileValues = readFile();
const fileFound = fileValues !== null;
const values = fileValues || {};

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Shell first, file second, so an export can always override for one run.
 *
 * Each source is cleaned before the fallback, not after. `process.env[key] ??`
 * only falls through on undefined, so a variable exported empty - which is
 * what `TELEGRAM_CHAT_ID=` in a wrapper script leaves behind - counted as a
 * value, hid the one in the file, and reported the alerts as unconfigured
 * while the file sat there correctly filled in.
 */
const get = (key) => clean(process.env[key]) ?? clean(values[key]);

/**
 * Warn, once, on a file anyone on the machine can read. Not an error: a
 * single user laptop is the normal deployment and the mode is often 644 by
 * nothing more than the umask that created it.
 */
function checkPermissions() {
  if (!fileFound) return;
  try {
    const mode = fs.statSync(FILE).mode & 0o077;
    if (mode !== 0) {
      console.warn(`${path.basename(FILE)} is readable by other users. chmod 600 it.`);
    }
  } catch {
    /* the mode is a courtesy, not a requirement */
  }
}

const FALLBACK_NAME = 'your Telegram chat';

/**
 * What the alert subsystem needs, and a sentence explaining what is missing
 * when it cannot work. The sentence is shown in the alert window, so it is
 * written for someone who has not read this file.
 *
 * The token and the chat ids are in here because the sender needs them. They
 * never leave the process: the API deliberately serves only `configured` and
 * `chatName`.
 *
 * `ownerId` is optional and changes nothing when it is absent. Set to your own
 * user id it lets the bot answer you in a private chat as well as in the chat
 * alerts go to,
 * which is the only way to get Telegram's Menu button: that button is drawn in
 * private chats and nowhere else, so in a group there is nothing to turn on.
 * Alerts are unaffected and still go to the group alone.
 */
export function telegramConfig() {
  const token = get('TELEGRAM_BOT_TOKEN');
  const chatId = get('TELEGRAM_CHAT_ID');
  const ownerId = get('TELEGRAM_OWNER_ID');
  // Where alerts go does not have to be a group. A user id sends them to that
  // person's private chat with the bot, which is the whole setup for someone
  // who is the only reader, so the name of the setting does not say group.
  const chatName = get('TELEGRAM_CHAT_NAME') || FALLBACK_NAME;

  let reason = null;
  if (!token && !chatId) {
    reason = fileFound
      ? 'config.env has no Telegram bot token or chat id yet.'
      : 'No config.env yet, so there is nowhere to send an alert.';
  } else if (!token) {
    reason = 'TELEGRAM_BOT_TOKEN is missing from config.env.';
  } else if (!chatId) {
    reason = 'TELEGRAM_CHAT_ID is missing from config.env.';
  }

  return { configured: Boolean(token && chatId), token, chatId, ownerId, chatName, reason };
}

/** One line at startup. Said once, so it is read rather than scrolled past. */
export function reportConfig() {
  checkPermissions();
  const { configured, reason, chatName } = telegramConfig();
  if (configured) console.log(`Price alerts will message ${chatName}.`);
  else console.log(`Price alerts are not configured: ${reason}`);
}

export const configPath = FILE;
