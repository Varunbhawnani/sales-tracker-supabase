import { supabase, subscribeToTable } from '../lib/supabase';
import { STATUS } from '../utils/constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

// ─── Local refresh event bus ────────────────────────────────────────────────
// Realtime pushes updates from server → all subscribers, but there's a 500ms-
// 1.5s roundtrip lag — too slow for "click → see change instantly" on the
// same device that issued the action. So every mutating action below also
// calls triggerLocalRefresh() which fans out to every active subscription's
// re-fetch immediately. Realtime still fires for OTHER devices.
const _refreshSubscribers = new Set();
function _subscribeRefresh(fn) {
  _refreshSubscribers.add(fn);
  return () => _refreshSubscribers.delete(fn);
}
function triggerLocalRefresh() {
  _refreshSubscribers.forEach(fn => {
    try { fn(); } catch (e) { console.error('refresh subscriber error:', e); }
  });
}

// Field-name mapping helper — the database uses snake_case, but the rest of
// the app code (carried over from the Firebase version) uses camelCase.
// We mirror Firebase's shape on the way out so screens don't have to change.
function rowToQuery(row) {
  if (!row) return null;
  const rawGam = row.gamification || {};
  const rawSnoozeHist = row.snooze_history || [];
  const rawDispHist = row.dispatch_history || [];

  return {
    id: row.id,
    customerMasterId: row.customer_master_id,
    customerName: row.customer_name,
    customerCategory: row.customer_category,
    items: row.items || [],
    requiredSets: row.required_sets,
    projectedRevenue: Number(row.projected_revenue || 0),
    notes: row.notes || '',
    status: row.status,
    createdBy: row.created_by_user_id ? { userId: row.created_by_user_id, name: row.created_by_name } : null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
    claimedBy: row.claimed_by_user_id ? { userId: row.claimed_by_user_id, name: row.claimed_by_name } : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    snoozedAt: row.snoozed_at ? new Date(row.snoozed_at) : null,
    followUpDate: row.follow_up_date ? new Date(row.follow_up_date) : null,
    snoozeHistory: rawSnoozeHist.map(h => ({
      snoozedAt: h.snoozed_at ? new Date(h.snoozed_at) : null,
      followUpDate: h.follow_up_date ? new Date(h.follow_up_date) : null,
      unsnoozedAt: h.unsnoozed_at ? new Date(h.unsnoozed_at) : null,
    })),
    wonAt: row.won_at ? new Date(row.won_at) : null,
    tallyInvoiceNumber: row.tally_invoice_number,
    verificationTimestamp: row.verification_timestamp ? new Date(row.verification_timestamp) : null,
    verificationError: row.verification_error,
    verificationNote: row.verification_note,
    authFailureCount: row.auth_failure_count || 0,
    lastAuthFailureAt: row.last_auth_failure_at ? new Date(row.last_auth_failure_at) : null,
    invoiceAttemptCount: row.invoice_attempt_count || 0,
    dispatchedSets: row.dispatched_sets || 0,
    dispatchHistory: rawDispHist.map(h => ({
      date: h.date ? new Date(h.date) : null,
      setsShipped: h.sets_shipped || 0,
      operator: h.operator || 'Unknown',
    })),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
    failureReason: row.failure_reason,
    gamification: {
      totalSnoozeMs: rawGam.total_snooze_ms || 0,
      timeToWinMs: rawGam.time_to_win_ms ?? null,
    },
  };
}

// ─── SUBSCRIPTIONS ─────────────────────────────────────────────────────────
const RECENT_QUERIES_LIMIT = 50;

/**
 * Subscribe to the most-recent queries in real-time.
 * Returns an unsubscribe function (same contract as the Firebase version).
 *
 * Note: Supabase Realtime doesn't sort within the subscription itself, so
 * we (a) do an initial select for the first 50, (b) listen to changes, and
 * (c) re-sort + re-cap on every change. For 50 docs this is trivial.
 */
export function subscribeToQueries(callback, errorCallback) {
  let cache = [];
  let pendingTimer = null;
  let inFlight = false;
  let dirty = false; // re-fetch flag set when events arrive mid-fetch

  const initial = async () => {
    if (inFlight) {
      // Mark dirty so we re-fetch when the current one completes — otherwise
      // events that arrive during a fetch get silently dropped.
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      dirty = false;
      const { data, error } = await supabase
        .from('queries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(RECENT_QUERIES_LIMIT);
      if (error) {
        console.error('Error loading queries:', error);
        if (errorCallback) errorCallback(error);
        return;
      }
      cache = data.map(rowToQuery);
      callback(cache);
    } finally {
      inFlight = false;
      if (dirty) initial(); // an event came in mid-fetch — try again
    }
  };

  initial();

  // Debounce realtime events so a burst doesn't trigger N back-to-back SELECTs.
  const scheduleRefetch = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      initial();
    }, 300);
  };

  const channel = subscribeToTable('queries', '*', scheduleRefetch);

  // Re-fetch when the app comes back to foreground.
  const appStateSub = AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') initial();
  });

  // Immediate refresh after any local action (triggerLocalRefresh below).
  const unsubRefresh = _subscribeRefresh(initial);

  return () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    appStateSub?.remove();
    unsubRefresh();
    channel.unsubscribe();
  };
}

/**
 * Subscribe to queries filtered by status list. Used by Accounts/Dispatch.
 */
export function subscribeToQueriesByStatuses(statuses, callback, errorCallback) {
  let cache = [];
  let pendingTimer = null;
  let inFlight = false;
  let dirty = false;

  const initial = async () => {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    try {
      dirty = false;
      const { data, error } = await supabase
        .from('queries')
        .select('*')
        .in('status', statuses)
        .order('created_at', { ascending: false });
      if (error) {
        console.error('Error loading filtered queries:', error);
        if (errorCallback) errorCallback(error);
        return;
      }
      cache = data.map(rowToQuery);
      callback(cache);
    } finally {
      inFlight = false;
      if (dirty) initial();
    }
  };

  initial();

  const scheduleRefetch = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      initial();
    }, 300);
  };

  const channel = subscribeToTable('queries', '*', scheduleRefetch);

  const appStateSub = AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') initial();
  });

  const unsubRefresh = _subscribeRefresh(initial);

  return () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    appStateSub?.remove();
    unsubRefresh();
    channel.unsubscribe();
  };
}

/**
 * Subscribe to a single query.
 */
export function subscribeToQuery(queryId, callback) {
  const initial = async () => {
    const { data } = await supabase.from('queries').select('*').eq('id', queryId).maybeSingle();
    if (data) callback(rowToQuery(data));
  };
  initial();
  const channel = supabase
    .channel(`public:queries:${queryId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'queries', filter: `id=eq.${queryId}`,
    }, async (payload) => {
      if (payload.eventType === 'DELETE') return;
      callback(rowToQuery(payload.new));
    })
    .subscribe();

  // Immediate refresh after any local action.
  const unsubRefresh = _subscribeRefresh(initial);

  return () => {
    unsubRefresh();
    channel.unsubscribe();
  };
}

// ─── READS ─────────────────────────────────────────────────────────────────
export async function getQueryById(queryId) {
  const { data, error } = await supabase.from('queries').select('*').eq('id', queryId).maybeSingle();
  if (error) throw error;
  return rowToQuery(data);
}

export async function getAllQueriesOnce() {
  const { data, error } = await supabase
    .from('queries').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(rowToQuery);
}

export async function getQueriesByUser(userId) {
  const { data, error } = await supabase
    .from('queries').select('*')
    .eq('claimed_by_user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(rowToQuery);
}

// ─── WRITES (via stored functions for atomic state-machine transitions) ──

export async function createQuery({
  customerMasterId,
  customerName,
  customerCategory,
  items,
  requiredSets,
  projectedRevenue,
  notes,
  userId,
  userName,
}) {
  const { data, error } = await supabase
    .from('queries')
    .insert({
      customer_master_id: customerMasterId,
      customer_name: customerName,
      customer_category: customerCategory || 'D',
      items: items || [],
      required_sets: Number(requiredSets),
      projected_revenue: Number(projectedRevenue) || 0,
      notes: notes || '',
      status: STATUS.OPEN_QUERY,
      created_by_user_id: userId,
      created_by_name: userName,
    })
    .select('id')
    .single();
  if (error) throw error;
  triggerLocalRefresh();
  return data.id;
}

export async function claimQuery(queryId, userId, userName, userRole) {
  // Role check is enforced server-side in the RPC, but we still pre-check
  // for a clear error message — matches the Firebase version's UX.
  if (userRole && userRole !== 'salesperson') {
    return { success: false, message: 'Only salespersons can claim queries.' };
  }
  const { data, error } = await supabase.rpc('claim_query', { query_id: queryId });
  if (error) return { success: false, message: error.message };
  if (data?.success) triggerLocalRefresh();
  return data;
}

export async function snoozeQuery(queryId, followUpDate) {
  const followUp = followUpDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const { data, error } = await supabase.rpc('snooze_query', {
    query_id: queryId, follow_up: followUp,
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function unsnoozeQuery(queryId) {
  const { data, error } = await supabase.rpc('unsnooze_query', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

const AUTO_UNSNOOZE_KEY = 'lastAutoUnsnoozeAt';
const AUTO_UNSNOOZE_COOLDOWN_MS = 5 * 60 * 1000;

export async function autoUnsnoozeExpired({ force = false } = {}) {
  if (!force) {
    try {
      const lastRunStr = await AsyncStorage.getItem(AUTO_UNSNOOZE_KEY);
      if (lastRunStr) {
        const lastRun = parseInt(lastRunStr, 10);
        if (Number.isFinite(lastRun) && Date.now() - lastRun < AUTO_UNSNOOZE_COOLDOWN_MS) return 0;
      }
    } catch (e) { /* ignore */ }
  }
  const { data, error } = await supabase.rpc('auto_unsnooze_expired');
  if (error) {
    console.error('auto_unsnooze_expired failed:', error);
    return 0;
  }
  try {
    await AsyncStorage.setItem(AUTO_UNSNOOZE_KEY, String(Date.now()));
  } catch (e) { /* ignore */ }
  if (data && data > 0) triggerLocalRefresh();
  return data || 0;
}

export async function markWon(queryId, requiredSets) {
  const { data, error } = await supabase.rpc('mark_won', {
    query_id: queryId, final_sets: Number(requiredSets),
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function markLostCancelled(queryId, reason) {
  const { data, error } = await supabase.rpc('mark_lost_cancelled', {
    query_id: queryId, reason: reason || '',
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function cancelVerificationFailed(queryId, reason) {
  const { data, error } = await supabase.rpc('cancel_verification_failed', {
    query_id: queryId, reason: reason || '',
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function submitInvoiceNumber(queryId, invoice) {
  const { data, error } = await supabase.rpc('submit_invoice_number', {
    query_id: queryId, invoice: invoice,
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function flagBackToSales(queryId, note) {
  const { data, error } = await supabase.rpc('flag_back_to_sales', {
    query_id: queryId, note: note || 'Flagged back by accounts team',
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function adminResetInvoiceAttempts(queryId) {
  const { data, error } = await supabase.rpc('admin_reset_invoice_attempts', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function updateDispatchedSets(queryId, setsShipped, operatorName) {
  const { data, error } = await supabase.rpc('update_dispatched_sets', {
    query_id: queryId,
    sets_shipped: Number(setsShipped),
    operator_name: operatorName || 'Unknown',
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}
