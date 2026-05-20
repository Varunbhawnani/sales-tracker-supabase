/**
 * notificationsService.js — in-app bell notifications (separate from push).
 *
 * Notifications are written automatically by Postgres triggers (migration 009)
 * whenever a query event happens that's relevant to a role. This service is
 * the client-side reader for those.
 */
import { supabase } from '../lib/supabase';
import { AppState } from 'react-native';

function rowToNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    relatedQueryId: row.related_query_id,
    isRead: row.is_read,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

const RECENT_LIMIT = 30;

/**
 * Subscribe to the current user's notifications.
 * Realtime pushes updates immediately. AppState.active triggers a refresh
 * when the app comes back to the foreground.
 *
 * Returns an unsubscribe function.
 */
let _notifChannelCounter = 0;
export function subscribeToMyNotifications(userId, callback) {
  if (!userId) return () => {};

  let cache = [];

  const initial = async () => {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(RECENT_LIMIT);
    if (error) {
      console.error('Error loading notifications:', error);
      return;
    }
    cache = (data || []).map(rowToNotification);
    callback(cache);
  };

  initial();

  _notifChannelCounter += 1;
  const channelName = `notifications:${userId}:${_notifChannelCounter}`;
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${userId}`,
    }, () => { initial(); })
    .subscribe();

  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') initial();
  });

  return () => {
    appStateSub?.remove();
    channel.unsubscribe();
  };
}

export async function markNotificationRead(notificationId) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
  if (error) throw new Error(error.message);
}

export async function markAllRead() {
  const { data, error } = await supabase.rpc('mark_all_notifications_read');
  if (error) throw new Error(error.message);
  return data || 0;
}
