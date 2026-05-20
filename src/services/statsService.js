import { supabase } from '../lib/supabase';
import { STATUS, LEGACY_STATUS, TIME_PERIODS } from '../utils/constants';
import { getStartOfWeek, getStartOfMonth } from '../utils/timeUtils';

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

function rowToStats(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    userId: row.user_id,
    name: row.name,
    totalClaimed: row.total_claimed,
    totalSuccessful: row.total_successful,
    totalUnsuccessful: row.total_unsuccessful,
    totalSetsSold: row.total_sets_sold,
  };
}

let _statsChannelCounter = 0;
export function subscribeToSalespersonStats(callback) {
  const initial = async () => {
    const { data, error } = await supabase
      .from('salesperson_stats').select('*')
      .order('total_sets_sold', { ascending: false });
    if (error) {
      console.error('Error loading stats:', error);
      return;
    }
    callback(data.map(rowToStats));
  };
  initial();
  _statsChannelCounter += 1;
  const channel = supabase
    .channel(`public:salesperson_stats:${_statsChannelCounter}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'salesperson_stats' }, initial)
    .subscribe();
  return () => channel.unsubscribe();
}

/**
 * Leaderboard for a time period.
 * - ALL_TIME → uses the cached salesperson_stats counters (1 read per user)
 * - This week / month → recomputes from queries with last_activity_at filter
 */
export async function getLeaderboardData(period = TIME_PERIODS.ALL_TIME) {
  // Exclude owners
  const { data: users } = await supabase.from('users').select('id, name, role');
  const ownerIds = new Set((users || []).filter(u => u.role === 'owner').map(u => u.id));

  if (period === TIME_PERIODS.ALL_TIME) {
    const { data, error } = await supabase
      .from('salesperson_stats').select('*')
      .order('total_sets_sold', { ascending: false });
    if (error) throw error;
    return data
      .filter(d => !ownerIds.has(d.user_id))
      .map((d, i) => ({ ...rowToStats(d), rank: i + 1 }));
  }

  let startDate;
  if (period === TIME_PERIODS.THIS_MONTH) startDate = getStartOfMonth();
  else if (period === TIME_PERIODS.THIS_WEEK) startDate = getStartOfWeek();

  const hasValidStartDate = startDate instanceof Date && !isNaN(startDate.getTime());

  let qry = supabase.from('queries').select('*');
  if (hasValidStartDate) qry = qry.gte('last_activity_at', startDate.toISOString());

  const { data: queries, error } = await qry;
  if (error) throw error;

  const statsMap = {};
  queries.forEach(q => {
    if (!q.claimed_by_user_id) return;
    const userId = q.claimed_by_user_id;
    if (!statsMap[userId]) {
      statsMap[userId] = {
        id: userId, userId, name: q.claimed_by_name || 'Unknown',
        totalClaimed: 0, totalSuccessful: 0, totalUnsuccessful: 0, totalSetsSold: 0,
      };
    }
    if (CLAIMED_STATUSES.includes(q.status)) statsMap[userId].totalClaimed++;
    if (WON_STATUSES.includes(q.status)) {
      statsMap[userId].totalSuccessful++;
      statsMap[userId].totalSetsSold += (q.required_sets || 0);
    }
    if (LOST_STATUSES.includes(q.status)) statsMap[userId].totalUnsuccessful++;
  });

  return Object.values(statsMap)
    .filter(d => !ownerIds.has(d.id))
    .sort((a, b) => b.totalSetsSold - a.totalSetsSold)
    .map((d, i) => ({ ...d, rank: i + 1 }));
}

export async function getMyStats(userId, period = TIME_PERIODS.ALL_TIME) {
  if (period === TIME_PERIODS.ALL_TIME) {
    const { data } = await supabase
      .from('salesperson_stats').select('*').eq('user_id', userId).maybeSingle();
    return rowToStats(data) || {
      totalClaimed: 0, totalSuccessful: 0, totalUnsuccessful: 0, totalSetsSold: 0,
    };
  }

  let startDate;
  if (period === TIME_PERIODS.THIS_MONTH) startDate = getStartOfMonth();
  else if (period === TIME_PERIODS.THIS_WEEK) startDate = getStartOfWeek();

  const { data: queries } = await supabase
    .from('queries').select('*')
    .eq('claimed_by_user_id', userId);
  let totalClaimed = 0, totalSuccessful = 0, totalUnsuccessful = 0, totalSetsSold = 0;
  (queries || []).forEach(q => {
    const closedAt = q.closed_at ? new Date(q.closed_at) : null;
    const wonAt = q.won_at ? new Date(q.won_at) : null;
    const claimedAt = q.claimed_at ? new Date(q.claimed_at) : null;
    const relevant = closedAt || wonAt || claimedAt;
    if (startDate && (!relevant || relevant < startDate)) return;
    totalClaimed++;
    if (WON_STATUSES.includes(q.status)) {
      totalSuccessful++;
      totalSetsSold += (q.required_sets || 0);
    }
    if (LOST_STATUSES.includes(q.status)) totalUnsuccessful++;
  });
  return { totalClaimed, totalSuccessful, totalUnsuccessful, totalSetsSold };
}
