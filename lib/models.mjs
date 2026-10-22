import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Model choices come from the official CLI: its initialize response lists every alias it accepts
// (opus, sonnet, fable, haiku) with the exact model each resolves to, plus pinned versions
// (claude-opus-4-6 …). The workbench stores the latest list per CLI login and validates by shape,
// so a new alias or version the CLI starts offering is selectable without a workbench release.
export const MODEL_FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'];
const PINNED = /^claude-[a-z0-9]+(?:-[a-z0-9]+){1,6}$/;
export const isModel = value => typeof value === 'string' && value.length <= 64 && (MODEL_FAMILIES.includes(value) || PINNED.test(value));
export const modelFamily = value => typeof value === 'string' ? MODEL_FAMILIES.find(family => value.toLowerCase().includes(family)) || null : null;

// Before any CLI has reported its list (fresh install), offer the aliases without version names.
export const FALLBACK_MODELS = [
  { value: 'opus', displayName: 'Opus' }, { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'fable', displayName: 'Fable' }, { value: 'haiku', displayName: 'Haiku' },
];
const FIELDS = ['value', 'resolvedModel', 'displayName', 'description', 'supportsEffort', 'supportedEffortLevels'];
const text = (value, limit) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

/** Keeps what the page needs from a CLI model entry. `default` duplicates an alias and is dropped. */
export function cleanModels(models) {
  const seen = new Set(), out = [];
  for (const item of Array.isArray(models) ? models : []) {
    if (!isModel(item?.value) || seen.has(item.value)) continue;
    seen.add(item.value);
    const entry = { value: item.value };
    for (const key of FIELDS.slice(1)) {
      const value = item[key];
      if (key === 'supportsEffort' && typeof value === 'boolean') entry[key] = value;
      else if (key === 'supportedEffortLevels' && Array.isArray(value)) entry[key] = value.filter(level => typeof level === 'string').slice(0, 10);
      else if (key === 'resolvedModel' && isModel(value)) entry[key] = value;
      else if (['displayName', 'description'].includes(key) && text(value, 120)) entry[key] = text(value, 120);
    }
    out.push(entry);
    if (out.length >= 40) break;
  }
  return out;
}

/** Which CLI login reported a list: the server's own login, or a config directory a plugin chose.
 * Only a hash of the directory is kept, so models.json never records local paths. */
export const contextKey = configDir => typeof configDir === 'string' && configDir ? `cli-${createHash('sha256').update(configDir).digest('hex').slice(0, 16)}` : 'default';

export class ModelCatalog {
  constructor({ dataDir }) { this.file = path.join(dataDir, 'models.json'); this.contexts = new Map(); }
  /** Loads the saved lists; on first start, seeds the server's own login from capabilities saved with sessions. */
  async init(sessions = []) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [key, value] of Object.entries(saved?.contexts || {})) {
        const models = cleanModels(value?.models);
        if (models.length && /^(default|cli-[a-f0-9]{16})$/.test(key)) this.contexts.set(key, { models, version: text(value.version, 40) || null, updatedAt: text(value.updatedAt, 40) || null });
      }
    } catch {}
    if (this.contexts.size) return;
    const latest = [...sessions].filter(s => s.capabilities?.models?.length).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (latest && this.observe('default', latest.capabilities.models, latest.capabilities.version, latest.updatedAt, false)) await this.save().catch(() => {});
  }
  /** Returns true when that login's list changed. */
  observe(key, models, version, at = new Date().toISOString(), persist = true) {
    const clean = cleanModels(models);
    if (!clean.length || typeof key !== 'string') return false;
    const previous = this.contexts.get(key);
    const same = previous && JSON.stringify(previous.models) === JSON.stringify(clean) && previous.version === (version || null);
    this.contexts.set(key, { models: clean, version: version || null, updatedAt: at });
    if (persist && !same) void this.save().catch(() => console.error('Model catalog persistence failed'));
    return !same;
  }
  /** Everything any login offers, newest report first, so a model one account adds (Fable on a
   * team plan) is selectable; before any report, the plain aliases. */
  list() {
    const seen = new Set(), out = [];
    for (const { models } of [...this.contexts.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))))
      for (const model of models) if (!seen.has(model.value)) { seen.add(model.value); out.push(model); }
    return out.length ? out : FALLBACK_MODELS;
  }
  resolve(key, value) {
    const own = this.contexts.get(key)?.models.find(model => model.value === value);
    return own?.resolvedModel || this.list().find(model => model.value === value)?.resolvedModel || (PINNED.test(value) ? value : null);
  }
  async save() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, contexts: Object.fromEntries(this.contexts) }), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
