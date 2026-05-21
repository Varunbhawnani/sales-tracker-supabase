import { supabase, subscribeToTable } from '../lib/supabase';

// role_responsibilities is admin-managed reference documentation: each role
// gets a list of responsibilities, each with a title + ordered steps.
// The shape stored in the DB is snake_case; we expose camelCase to screens.

function rowToResponsibility(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    title: row.title,
    steps: Array.isArray(row.steps) ? row.steps : [],
    orderIndex: row.order_index || 0,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getResponsibilities(role) {
  let q = supabase.from('role_responsibilities').select('*').order('order_index', { ascending: true });
  if (role) q = q.eq('role', role);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToResponsibility);
}

export function subscribeToResponsibilities(callback, { role } = {}) {
  let inFlight = false;
  let dirty = false;

  const refresh = async () => {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    try {
      dirty = false;
      const list = await getResponsibilities(role);
      callback(list);
    } catch (e) {
      console.error('responsibilities refresh failed:', e);
      callback([]);
    } finally {
      inFlight = false;
      if (dirty) refresh();
    }
  };

  refresh();
  const channel = subscribeToTable('role_responsibilities', '*', refresh);
  return () => { channel.unsubscribe(); };
}

// ─── Writes (owner only via RLS) ──────────────────────────────────────────

export async function createResponsibility(role, title, steps = []) {
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle) throw new Error('Title is required.');
  const cleanedSteps = (steps || []).map((s) => (s || '').trim()).filter(Boolean);
  const { error } = await supabase
    .from('role_responsibilities')
    .insert({ role, title: trimmedTitle, steps: cleanedSteps, order_index: 0 });
  if (error) throw new Error(error.message);
}

export async function updateResponsibility(id, patch) {
  const update = {};
  if (patch.title !== undefined) update.title = (patch.title || '').trim();
  if (patch.steps !== undefined) {
    update.steps = (patch.steps || []).map((s) => (s || '').trim()).filter(Boolean);
  }
  if (patch.orderIndex !== undefined) update.order_index = patch.orderIndex;
  const { error } = await supabase.from('role_responsibilities').update(update).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteResponsibility(id) {
  const { error } = await supabase.from('role_responsibilities').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
