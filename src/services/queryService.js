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
    // Godown the query was tagged with at creation. NULL = visible to all
    // (legacy queries pre-019 OR a salesperson with no godown assigned).
    godownId: row.godown_id || null,
    items: row.items || [],
    requiredSets: row.required_sets,
    projectedRevenue: Number(row.projected_revenue || 0),
    notes: row.notes || '',
    origin: row.origin || null,
    cartoons: row.cartoons || 0,
    lots: row.lots || 0,
    followUpNote: row.follow_up_note || null,
    followUpOrigin: row.follow_up_origin || null,
    followUpResolved: !!row.follow_up_resolved,
    status: row.status,
    createdBy: row.created_by_user_id ? { userId: row.created_by_user_id, name: row.created_by_name } : null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
    claimedBy: row.claimed_by_user_id ? { userId: row.claimed_by_user_id, name: row.claimed_by_name } : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    snoozedAt: row.snoozed_at ? new Date(row.snoozed_at) : null,
    // Optional follow-up date — set from mark_won or snooze_query. Backed by
    // the new column added in migration 018; older rows have it as null.
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
    invoiceEntries: (row.invoice_entries || []).map(e => ({
      invoiceNo: e.invoice_no,
      cartoons: e.cartoons || 0,
      lots: e.lots || 0,
      status: e.status,
      addedAt: e.added_at ? new Date(e.added_at) : null,
      verifiedAt: e.verified_at ? new Date(e.verified_at) : null,
      verificationError: e.verification_error || null,
    })),
    dispatchedSets: row.dispatched_sets || 0,
    dispatchHistory: rawDispHist.map(h => ({
      date: h.date ? new Date(h.date) : null,
      setsShipped: h.sets_shipped || 0,
      operator: h.operator || 'Unknown',
    })),
    isPacked: !!row.is_packed,
    packedAt: row.packed_at ? new Date(row.packed_at) : null,
    packedByName: row.packed_by_name || null,
    packedByUserId: row.packed_by_user_id || null,
    dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at) : null,
    dispatchedByName: row.dispatched_by_name || null,
    dispatchedByUserId: row.dispatched_by_user_id || null,
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
// Visibility window — queries older than this disappear from dashboards
// (Follow-Ups tab uses its own query and is exempt).
const VISIBILITY_DAYS = 15;
function visibilityCutoffISO() {
  return new Date(Date.now() - VISIBILITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

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
        .gte('last_activity_at', visibilityCutoffISO())
        .order('created_at', { ascending: false })
        .limit(RECENT_QUERIES_LIMIT);
      if (error) {
        console.error('Error loading queries:', error);
        if (errorCallback) errorCallback(error);
        // Important: always invoke callback so screens that flip loading
        // state inside the callback don't sit on a spinner forever when the
        // network fails. Subsequent retries (Realtime / AppState) repopulate.
        callback(cache.length ? cache : []);
        return;
      }
      cache = data.map(rowToQuery);
      callback(cache);
    } catch (e) {
      console.error('subscribeToQueries threw:', e?.message || e);
      if (errorCallback) errorCallback(e);
      callback(cache.length ? cache : []);
    } finally {
      inFlight = false;
      if (dirty) initial();
    }
  };

  initial();

  const scheduleRefetch = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; initial(); }, 300);
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
        .gte('last_activity_at', visibilityCutoffISO())
        .order('created_at', { ascending: false });
      if (error) {
        console.error('Error loading filtered queries:', error);
        if (errorCallback) errorCallback(error);
        callback(cache.length ? cache : []);
        return;
      }
      cache = data.map(rowToQuery);
      callback(cache);
    } catch (e) {
      console.error('subscribeToQueriesByStatuses threw:', e?.message || e);
      if (errorCallback) errorCallback(e);
      callback(cache.length ? cache : []);
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
 * Subscribe to queries that have an unresolved follow-up note.
 * Used by the Follow-Ups tab (sales + owner).
 */
export function subscribeToFollowUps(callback, errorCallback) {
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
        .not('follow_up_note', 'is', null)
        .eq('follow_up_resolved', false)
        .order('last_activity_at', { ascending: false });
      if (error) {
        console.error('Error loading follow-ups:', error);
        if (errorCallback) errorCallback(error);
        callback([]);
        return;
      }
      callback(data.map(rowToQuery));
    } catch (e) {
      console.error('subscribeToFollowUps threw:', e?.message || e);
      if (errorCallback) errorCallback(e);
      callback([]);
    } finally {
      inFlight = false;
      if (dirty) initial();
    }
  };

  initial();

  const scheduleRefetch = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; initial(); }, 300);
  };

  const channel = subscribeToTable('queries', '*', scheduleRefetch);
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') initial();
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
  origin,
  notes,
  userId,
  userName,
  godownId,
}) {
  // Note: cartoons/lots quantities are entered at Mark Booked time (not here).
  // Products in a query are optional — a query may just be "send photos of X".
  // godownId scopes who sees this query; NULL = visible to everyone (the user
  // either had no godown assigned, or explicitly chose 'None' on the picker).
  const { data, error } = await supabase
    .from('queries')
    .insert({
      customer_master_id: customerMasterId,
      customer_name: customerName,
      customer_category: customerCategory || 'D',
      items: items || [],
      required_sets: 0,
      projected_revenue: 0,
      notes: notes || '',
      origin: origin || null,
      status: STATUS.OPEN_QUERY,
      created_by_user_id: userId,
      created_by_name: userName,
      godown_id: godownId || null,
    })
    .select('id')
    .single();
  if (error) throw error;
  triggerLocalRefresh();
  return data.id;
}

export async function claimQuery(queryId, userId, userName, userRole) {
  // Role check is enforced server-side in the RPC; this pre-check gives a
  // clean error message before the network call.
  if (userRole && userRole !== 'salesperson' && userRole !== 'owner') {
    return { success: false, message: 'Only salesperson or owner can claim queries.' };
  }
  const { data, error } = await supabase.rpc('claim_query', { query_id: queryId });
  if (error) return { success: false, message: error.message };
  if (data?.success) triggerLocalRefresh();
  return data;
}

export async function snoozeQuery(queryId, followUpDate, note) {
  const followUp = followUpDate.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc('snooze_query', {
    query_id: queryId, follow_up: followUp, note: (note || '').trim(),
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

export async function markWon(queryId, cartoons, lots, followUpNote, followUpDate) {
  const { data, error } = await supabase.rpc('mark_won', {
    query_id: queryId,
    p_cartoons: Number(cartoons) || 0,
    p_lots: Number(lots) || 0,
    p_follow_up_note: (followUpNote || '').trim() || null,
    // YYYY-MM-DD or null. Postgres DATE column accepts the ISO date string.
    p_follow_up_date: followUpDate ? toISODate(followUpDate) : null,
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

function toISODate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return null;
}

export async function pickupFollowUp(queryId) {
  const { data, error } = await supabase.rpc('pickup_follow_up', { query_id: queryId });
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

export async function addInvoiceEntry(queryId, invoiceNo, cartoons, lots) {
  const { data, error } = await supabase.rpc('add_invoice_entry', {
    query_id: queryId,
    invoice_no: (invoiceNo || '').trim(),
    entry_cartoons: Number(cartoons) || 0,
    entry_lots: Number(lots) || 0,
  });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}

export async function accountsUpdateQuantity(queryId, cartoons, lots) {
  const { data, error } = await supabase.rpc('accounts_update_quantity', {
    query_id: queryId,
    new_cartoons: Number(cartoons) || 0,
    new_lots: Number(lots) || 0,
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

export async function markPacked(queryId) {
  const { data, error } = await supabase.rpc('mark_packed', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}
export async function undoPacked(queryId) {
  const { data, error } = await supabase.rpc('undo_packed', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}
export async function markDispatched(queryId) {
  const { data, error } = await supabase.rpc('mark_dispatched', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}
export async function undoDispatched(queryId) {
  const { data, error } = await supabase.rpc('undo_dispatched', { query_id: queryId });
  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.message);
  triggerLocalRefresh();
}
