import { supabase, subscribeToTable } from '../lib/supabase';

// Godowns are an admin-side organisation aid. RLS allows any authenticated
// user to read the list (so non-owner UIs can render a godown name next to
// other users for context if we ever need it) but only the owner can write.

function rowToGodown(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active !== false,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getGodowns({ includeInactive = false } = {}) {
  let q = supabase.from('godowns').select('*').order('name', { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToGodown);
}

// Realtime subscription. Re-fetches on any change to the godowns table so the
// Admin screen shows additions / deactivations from other owner sessions
// without needing a manual refresh.
export function subscribeToGodowns(callback, { includeInactive = false } = {}) {
  let inFlight = false;
  let dirty = false;

  const refresh = async () => {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    try {
      dirty = false;
      const list = await getGodowns({ includeInactive });
      callback(list);
    } catch (e) {
      console.error('godowns refresh failed:', e);
    } finally {
      inFlight = false;
      if (dirty) refresh();
    }
  };

  refresh();
  const channel = subscribeToTable('godowns', '*', refresh);
  return () => { channel.unsubscribe(); };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createGodown(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Godown name required.');
  const { error } = await supabase
    .from('godowns')
    .insert({ name: trimmed, is_active: true });
  if (error) {
    if (error.code === '23505') throw new Error('A godown with this name already exists.');
    throw new Error(error.message);
  }
}

export async function renameGodown(id, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Godown name required.');
  const { error } = await supabase.from('godowns').update({ name: trimmed }).eq('id', id);
  if (error) {
    if (error.code === '23505') throw new Error('A godown with this name already exists.');
    throw new Error(error.message);
  }
}

export async function setGodownActive(id, isActive) {
  const { error } = await supabase
    .from('godowns')
    .update({ is_active: !!isActive })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function assignUserGodown(userId, godownId) {
  const { data, error } = await supabase.rpc('assign_user_godown', {
    p_user_id: userId,
    p_godown_id: godownId,  // can be null to clear
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed to assign godown.');
}
