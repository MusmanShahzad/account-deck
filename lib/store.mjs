// Profile storage: one JSON file per saved account, readable only by the current user.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { retryLocked } from './winapp.mjs';

export const HOME = process.env.ACCOUNT_DECK_HOME || path.join(os.homedir(), '.account-deck');
const ID = /^[a-f0-9]{12}$/;

function dir(provider) {
  const d = path.join(HOME, provider);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function writeSecret(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { retryLocked(() => fs.renameSync(tmp, file)); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export function list(provider) {
  const d = dir(provider);
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.savedAt - b.savedAt);
}

export function get(provider, id) {
  if (!ID.test(id)) return null;
  return list(provider).find((p) => p.id === id) || null;
}

export function save(provider, profile) {
  if (!ID.test(profile.id)) throw new Error('bad profile id');
  writeSecret(path.join(dir(provider), `${profile.id}.json`), JSON.stringify(profile));
}

export function remove(provider, id) {
  if (!ID.test(id)) return;
  fs.rmSync(path.join(dir(provider), `${id}.json`), { force: true });
}

export const newId = () => crypto.randomBytes(6).toString('hex');
