import { supabase, subscribeToTable } from '../lib/supabase';
import { AppState } from 'react-native';

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    fromUserName: row.from_user_name,
    toUserId: row.to_user_id,
    toUserName: row.to_user_name,
    title: row.title,
    description: row.description || '',
    isCompleted: !!row.is_completed,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    completedByUserId: row.completed_by_user_id || null,
    // Added in migration 018:
    dueDate: row.due_date ? new Date(row.due_date) : null,
    nextDueDate: row.next_due_date ? new Date(row.next_due_date) : null,
    lastCompletedAt: row.last_completed_at ? new Date(row.last_completed_at) : null,
    recurrence: row.recurrence || null,
    notifySettings: row.notify_settings || { on_assign: true, before_due_hours: 1, at_due: true },
  };
}

export function subscribeToMyTasks(userId, callback) {
  if (!userId) return () => {};
  let pendingTimer = null;
  let inFlight = false;
  let dirty = false;

  const initial = async () => {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    try {
      dirty = false;
      const { data, error } = await supabase
        .from('tasks').select('*')
        .or(`to_user_id.eq.${userId},from_user_id.eq.${userId}`)
        .order('created_at', { ascending: false });
      if (error) {
        console.error('tasks load error', error);
        callback([]);
        return;
      }
      callback((data || []).map(rowToTask));
    } catch (e) {
      console.error('subscribeToMyTasks threw:', e?.message || e);
      callback([]);
    } finally { inFlight = false; if (dirty) initial(); }
  };

  initial();

  const scheduleRefetch = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; initial(); }, 300);
  };

  const channel = subscribeToTable('tasks', '*', scheduleRefetch);
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') initial();
  });

  return () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    appStateSub?.remove();
    channel.unsubscribe();
  };
}

/**
 * Create a task. The new options are passed through to the create_task RPC
 * which was extended in migration 018.
 *
 * Parameters:
 *   toUserId     — recipient
 *   title        — required
 *   description  — optional free-form note
 *   options.dueDate    — Date or null. For one-time tasks, the actual due
 *                        date. For recurring tasks the initial due date
 *                        (overridden by recurrence.start_date if present).
 *   options.recurrence — null for one-time, else
 *                        { type: 'days'|'weekday'|'day_of_month',
 *                          interval: N, weekdays: [1..7], day_of_month: 1..31,
 *                          start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD'|null }
 *   options.notifySettings — { on_assign, before_due_hours, at_due }
 */
export async function createTask(toUserId, title, description, options = {}) {
  const { data, error } = await supabase.rpc('create_task', {
    to_user_id: toUserId,
    title,
    description: description || null,
    p_due_date: options.dueDate ? toISODate(options.dueDate) : null,
    p_recurrence: options.recurrence || null,
    p_notify_settings: options.notifySettings || null,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed.');
}

export async function toggleTask(taskId) {
  const { data, error } = await supabase.rpc('toggle_task', { task_id: taskId });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed.');
}

function toISODate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return null;
}

// Recurrence option helper — used by TasksScreen to render the right chip.
export function describeRecurrence(rec) {
  if (!rec) return 'One-time';
  if (rec.type === 'days') {
    const n = rec.interval || 1;
    return n === 1 ? 'Daily' : `Every ${n} days`;
  }
  if (rec.type === 'weekday') {
    const days = (rec.weekdays || []).map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d - 1]).filter(Boolean);
    return `Weekly · ${days.join(', ') || '—'}`;
  }
  if (rec.type === 'day_of_month') {
    const dom = rec.day_of_month || 1;
    const n = rec.interval || 1;
    return n === 1 ? `Monthly · day ${dom}` : `Every ${n} months · day ${dom}`;
  }
  return 'Recurring';
}
