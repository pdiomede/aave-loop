/**
 * Settings from the environment, by their name without a prefix.
 *
 * `setting('DB')` reads `ETHROUNDTRIP_DB`, and failing that `MYAAVE_DB`: the
 * settings carried the app's first name, myAave, until 20 Nov 2026, and an
 * install configured then - a systemd unit, a wrapper script, a cron line -
 * goes on working without an edit. Empty counts as unset, as it always has
 * here: `MYAAVE_DB= npm start` meant the default.
 *
 * Server-only, at the root with the rest of them: the browser is served `lib/`
 * and has no environment.
 */

export const PREFIX = 'ETHROUNDTRIP_';
export const OLD_PREFIX = 'MYAAVE_';

const present = (v) => v !== undefined && v !== null && v !== '';

/** The value of a setting, the new name first, or undefined. */
export function setting(name) {
  const now = process.env[PREFIX + name];
  if (present(now)) return now;
  const before = process.env[OLD_PREFIX + name];
  return present(before) ? before : undefined;
}

/**
 * The name a setting was given under, for a message that quotes it: the old
 * one only when that is where the value came from.
 */
export function settingName(name) {
  return !present(process.env[PREFIX + name]) && present(process.env[OLD_PREFIX + name])
    ? OLD_PREFIX + name
    : PREFIX + name;
}

/**
 * The old names set, as a line for the startup log, or null: the nudge to
 * rename them in the service file, said once. One whose new name is set too
 * is not read at all, and is said to be ignored - listed as "still read", a
 * line left behind halfway through the rename looked as if it counted.
 */
export function oldSettingsNote() {
  const old = Object.keys(process.env)
    .filter((k) => k.startsWith(OLD_PREFIX) && present(process.env[k]))
    .sort();
  if (old.length === 0) return null;
  const newName = (k) => PREFIX + k.slice(OLD_PREFIX.length);
  const read = old.filter((k) => !present(process.env[newName(k)]));
  const ignored = old.filter((k) => present(process.env[newName(k)]));
  const parts = [];
  if (read.length) {
    parts.push(
      `Old setting names still read: ${read.map((k) => `${k} -> ${newName(k)}`).join(', ')}. ` +
        'They keep working; rename them when convenient.',
    );
  }
  if (ignored.length) {
    parts.push(
      `Ignored, as the new name is set: ${ignored.map((k) => `${k} (${newName(k)} is used)`).join(', ')}. ` +
        'Remove them.',
    );
  }
  return parts.join(' ');
}
