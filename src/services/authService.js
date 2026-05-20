import { supabase } from '../lib/supabase';
import { EMAIL_DOMAIN, ROLES } from '../utils/constants';

/**
 * Create a new user with the specified role.
 *
 * Calls the `admin_create_user` Postgres function (migration 005) which:
 *   1. Verifies the caller is an owner (server-side, can't be bypassed)
 *   2. Writes directly into auth.users + auth.identities (no signup flow,
 *      no email sent, no rate limit)
 *   3. Inserts the public.users + salesperson_stats rows in the same
 *      transaction
 *
 * Avoids Supabase's email-signup gymnastics (no "Allow signups" toggle, no
 * "Confirm email" toggle, no SMTP rate-limit). The owner's session stays
 * intact throughout — no signOut/re-login dance like the old signUp approach.
 */
export async function createUser(name, username, password, role = ROLES.SALESPERSON) {
  const { data, error } = await supabase.rpc('admin_create_user', {
    p_username: username.trim().toLowerCase(),
    p_password: password,
    p_name: name.trim(),
    p_role: role,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Failed to create user.');
  return {
    uid: data.uid,
    name: name.trim(),
    username: username.trim().toLowerCase(),
    role,
  };
}

export async function getAllUsers() {
  const { data, error } = await supabase
    .from('users').select('*').order('name', { ascending: true });
  if (error) throw error;
  return data.map(rowToUser);
}

export async function getUsersByRole(role) {
  const { data, error } = await supabase
    .from('users').select('*').eq('role', role).order('name', { ascending: true });
  if (error) throw error;
  return data.map(rowToUser);
}

export async function getAllSalespeople() {
  return getUsersByRole(ROLES.SALESPERSON);
}

export async function deactivateUser(userId) {
  const { error } = await supabase
    .from('users').update({ is_active: false }).eq('id', userId);
  if (error) throw error;
}

export async function reactivateUser(userId) {
  const { error } = await supabase
    .from('users').update({ is_active: true }).eq('id', userId);
  if (error) throw error;
}

export async function updateUserRole(userId, newRole) {
  const { error } = await supabase
    .from('users').update({ role: newRole }).eq('id', userId);
  if (error) throw error;
}

// Legacy aliases (carried over from Firebase version's compatibility shims)
export const createSalesperson = (name, username, password) =>
  createUser(name, username, password, ROLES.SALESPERSON);
export const deactivateSalesperson = deactivateUser;
export const reactivateSalesperson = reactivateUser;

function rowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    expoPushToken: row.expo_push_token,
    createdAt: row.created_at,
  };
}
