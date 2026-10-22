import { modelFamily } from '../../lib/models.mjs';

// Which logged-in account should run the next turn. Usage is each account's latest official
// view: /usage probes plus the live 5h/7d windows of every served request (lib/usage.mjs).
export const SWITCH_LEVELS = [90, 95, 98, 100];
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** How full an account is for a turn on `model`: the highest utilization among the windows that
 * would stop it (5h, all-model weekly, the model's own weekly meter). Unknown windows do not count;
 * a window whose reset has passed counts as reset. An official rejection blocks until its deadline.
 */
export function quotaLoad(account, { model, now = Date.now() } = {}) {
  const usage = account?.usage || {}, family = modelFamily(model);
  const current = window => finite(window?.utilization) && !(window.resetsAt && Date.parse(window.resetsAt) <= now) ? window.utilization : null;
  const values = [current(usage.fiveHour), current(usage.sevenDay),
    ...(usage.scopes || []).filter(scope => family && modelFamily(scope?.model) === family).map(current)].filter(value => value !== null);
  const blockedUntil = usage.rateLimited && usage.cooldownUntil && Date.parse(usage.cooldownUntil) > now ? usage.cooldownUntil : null;
  // A rejection without a reset deadline is not permission to immediately retry.
  // A fresh official allowed event or a known elapsed reset clears this block.
  const blockedWithoutDeadline = usage.rateLimited === true && !Number.isFinite(Date.parse(usage.cooldownUntil));
  const load = values.length ? Math.max(...values) : null;
  return { load, blockedUntil, exhausted: Boolean(blockedUntil) || blockedWithoutDeadline || (load !== null && load >= 100) };
}

/** Accounts that can take a turn now, emptiest first (unknown usage last). `below` drops accounts
 * already at the switch threshold, so a proactive switch never lands on one about to run out too.
 */
export function routeCandidates(accounts, { exclude = [], model, below = 100, now = Date.now() } = {}) {
  return accounts.filter(account => !exclude.includes(account.id) && account.enabled !== false && account.auth?.loggedIn === true)
    .map(account => ({ account, ...quotaLoad(account, { model, now }) }))
    .filter(candidate => !candidate.exhausted && (candidate.load ?? 0) < below)
    .sort((a, b) => (a.load ?? Infinity) - (b.load ?? Infinity) || 0);
}

// The account a session is on should hand over before its turn starts.
export function shouldSwitch(account, { model, switchAt = 100, now = Date.now() } = {}) {
  const quota = quotaLoad(account, { model, now });
  return quota.exhausted || (quota.load !== null && quota.load >= switchAt);
}

export function limitName(type) {
  const known = { five_hour: '5 小时额度', seven_day: '本周额度', seven_day_overage_included: '本周额度', overage: '额外用量' }[type];
  if (known) return known;
  // seven_day_opus, seven_day_fable …: the model's own weekly meter.
  const family = typeof type === 'string' && /^seven_day_/.test(type) ? modelFamily(type) : null;
  return family ? `${family[0].toUpperCase()}${family.slice(1)} 本周额度` : '额度';
}
