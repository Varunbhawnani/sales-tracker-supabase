import { supabase } from '../lib/supabase';
import { STATUS, LEGACY_STATUS, TIME_PERIODS } from '../utils/constants';

const WON_STATUSES = [
  STATUS.WON_PENDING_ACCOUNTS,
  STATUS.PENDING_VERIFICATION,
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED,
  STATUS.COMPLETED,
  LEGACY_STATUS.SUCCESSFUL,
];
const LOST_STATUSES = [STATUS.LOST_CANCELLED, LEGACY_STATUS.UNSUCCESSFUL];
const CLAIMED_STATUSES = [
  STATUS.CLAIMED_BY_SALES, STATUS.SNOOZED, STATUS.VERIFICATION_FAILED,
  ...WON_STATUSES, ...LOST_STATUSES, LEGACY_STATUS.CLAIMED,
];

// ─── Time-window helpers ─────────────────────────────────────────────────
function startOfThisWeek() {
  const d = new Date();
  const day = d.getDay() || 7; // Sun=0 → 7
  if (day !== 1) d.setHours(-24 * (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfThisMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfThisYear() {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1);
}
function periodStart(period) {
  switch (period) {
    case TIME_PERIODS.THIS_WEEK: return startOfThisWeek();
    case TIME_PERIODS.THIS_MONTH: return startOfThisMonth();
    case TIME_PERIODS.THIS_YEAR: return startOfThisYear();
    case TIME_PERIODS.ALL_TIME:
    default: return null;
  }
}

// ─── Pure computation: returns leaderboard rows for the given period ─────
async function fetchUsers() {
  const { data } = await supabase.from('users').select('id, name, role, is_active');
  return data || [];
}

async function fetchQueriesForPeriod(period) {
  const start = periodStart(period);
  let q = supabase.from('queries').select(
    'id, status, claimed_by_user_id, claimed_by_name, cartoons, lots, required_sets, last_activity_at, created_at'
  );
  if (start) q = q.gte('last_activity_at', start.toISOString());
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

function aggregateBySalesperson(queries, owners) {
  const ownerIds = new Set(owners);
  const map = {};
  for (const q of queries) {
    if (!q.claimed_by_user_id || ownerIds.has(q.claimed_by_user_id)) continue;
    const userId = q.claimed_by_user_id;
    if (!map[userId]) {
      map[userId] = {
        id: userId, userId,
        name: q.claimed_by_name || 'Unknown',
        totalClaimed: 0, totalSuccessful: 0, totalUnsuccessful: 0,
        totalCartoons: 0, totalLots: 0, totalSetsSold: 0,
      };
    }
    const entry = map[userId];
    const isWon = WON_STATUSES.includes(q.status);
    const isLost = LOST_STATUSES.includes(q.status);
    const isClaimed = CLAIMED_STATUSES.includes(q.status);

    if (isClaimed) entry.totalClaimed += 1;
    if (isWon) {
      entry.totalSuccessful += 1;
      const c = q.cartoons || 0;
      const l = q.lots || 0;
      const fallback = q.required_sets || 0;
      // If cartoons+lots are both zero (very old queries), fall back to required_sets.
      const setsLike = (c + l) > 0 ? (c + l) : fallback;
      entry.totalCartoons += c;
      entry.totalLots += l;
      entry.totalSetsSold += setsLike;
    }
    if (isLost) entry.totalUnsuccessful += 1;
  }
  return Object.values(map);
}

// ─── Public API ──────────────────────────────────────────────────────────
export async function getLeaderboardData(period = TIME_PERIODS.ALL_TIME) {
  const [queries, users] = await Promise.all([fetchQueriesForPeriod(period), fetchUsers()]);
  const owners = users.filter(u => u.role === 'owner').map(u => u.id);

  const rows = aggregateBySalesperson(queries, owners);
  return rows
    .sort((a, b) => (b.totalCartoons + b.totalLots) - (a.totalCartoons + a.totalLots))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export async function getMyStats(userId, period = TIME_PERIODS.ALL_TIME) {
  if (!userId) {
    return { totalClaimed: 0, totalSuccessful: 0, totalUnsuccessful: 0, totalCartoons: 0, totalLots: 0, totalSetsSold: 0 };
  }
  const queries = await fetchQueriesForPeriod(period);
  const mine = queries.filter(q => q.claimed_by_user_id === userId);
  const agg = aggregateBySalesperson(mine, [])[0];
  return agg || { id: userId, userId, name: '', totalClaimed: 0, totalSuccessful: 0, totalUnsuccessful: 0, totalCartoons: 0, totalLots: 0, totalSetsSold: 0 };
}
