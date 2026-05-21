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
      if (error) { console.error('tasks load error', error); return; }
      callback((data || []).map(rowToTask));
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

export async function createTask(toUserId, title, description) {
  const { data, error } = await supabase.rpc('create_task', {
    to_user_id: toUserId, title: title, description: description || null,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed.');
}

export async function toggleTask(taskId) {
  const { data, error } = await supabase.rpc('toggle_task', { task_id: taskId });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed.');
}
