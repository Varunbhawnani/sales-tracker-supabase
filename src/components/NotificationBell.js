import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Modal, FlatList,
  StyleSheet, Pressable,
} from 'react-native';
import { COLORS } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import {
  subscribeToMyNotifications,
  markNotificationRead,
  markAllRead,
} from '../services/notificationsService';
import { relativeTime } from '../utils/timeUtils';
import { useNavigation } from '@react-navigation/native';

const ICONS = {
  new_query: '📩',
  pending_verification: '🧾',
  ready_to_dispatch: '🚚',
  booked: '✅',
  query_locked: '🔒',
  default: '🔔',
};

export default function NotificationBell({ style }) {
  const { userId, isOwner, isSalesperson, isAccounts, isDispatch } = useAuth();
  const navigation = useNavigation();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!userId) return undefined;
    const unsub = subscribeToMyNotifications(userId, setNotifications);
    return unsub;
  }, [userId]);

  const unreadCount = notifications.filter(n => !n.isRead).length;

  const handleTap = async (notification) => {
    setOpen(false);
    if (!notification.isRead) {
      try { await markNotificationRead(notification.id); } catch (e) { /* silent */ }
    }
    // For salesperson / owner we can navigate to QueryDetail inside their Feed
    // stack. For accounts / dispatch / packing the bell just marks the
    // notification as read and stays on the current dashboard — that's where
    // they take action anyway.
    if (notification.relatedQueryId && (isSalesperson || isOwner)) {
      try {
        // Resolve the navigation route safely. Different navigators name
        // their feed stack differently (FeedStack on native bottom tabs,
        // 'Feed' on the web sidebar). Try a few common names.
        const tries = [
          () => navigation.navigate('FeedStack', { screen: 'QueryDetail', params: { queryId: notification.relatedQueryId } }),
          () => navigation.navigate('Feed', { screen: 'QueryDetail', params: { queryId: notification.relatedQueryId } }),
          () => navigation.navigate('QueryDetail', { queryId: notification.relatedQueryId }),
        ];
        for (const attempt of tries) {
          try { attempt(); return; } catch (e) { /* try next */ }
        }
      } catch (e) { /* silent — stay on current screen */ }
    }
  };

  const handleMarkAllRead = async () => {
    try { await markAllRead(); } catch (e) { /* silent */ }
  };

  const renderItem = ({ item }) => (
    <Pressable
      onPress={() => handleTap(item)}
      style={[styles.row, !item.isRead && styles.rowUnread]}
    >
      <Text style={styles.rowIcon}>{ICONS[item.type] || ICONS.default}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.rowMessage} numberOfLines={2}>{item.message}</Text>
        <Text style={styles.rowTime}>{relativeTime(item.createdAt)}</Text>
      </View>
      {!item.isRead && <View style={styles.unreadDot} />}
    </Pressable>
  );

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        style={[styles.bellWrap, style]}
        accessibilityLabel={`Notifications (${unreadCount} unread)`}
      >
        <Text style={styles.bellIcon}>🔔</Text>
        {unreadCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.header}>
              <Text style={styles.headerTitle}>Notifications</Text>
              <View style={styles.headerActions}>
                {unreadCount > 0 && (
                  <TouchableOpacity onPress={handleMarkAllRead}>
                    <Text style={styles.markAllText}>Mark all read</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setOpen(false)} style={styles.closeBtn}>
                  <Text style={styles.closeText}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>

            {notifications.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyIcon}>🔕</Text>
                <Text style={styles.emptyTitle}>No notifications yet</Text>
                <Text style={styles.emptyHint}>
                  You'll see new queries, invoice updates, and dispatch alerts here.
                </Text>
              </View>
            ) : (
              <FlatList
                data={notifications}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                contentContainerStyle={{ paddingBottom: 24 }}
                showsVerticalScrollIndicator={false}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border,
    justifyContent: 'center', alignItems: 'center',
    position: 'relative',
  },
  bellIcon: { fontSize: 18 },
  badge: {
    position: 'absolute', top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.danger,
    paddingHorizontal: 4,
    justifyContent: 'center', alignItems: 'center',
  },
  badgeText: { fontSize: 10, color: COLORS.white, fontFamily: 'Inter_700Bold' },
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '85%', minHeight: 200,
    paddingTop: 8,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.divider,
  },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  markAllText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
  closeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: COLORS.background,
    justifyContent: 'center', alignItems: 'center',
  },
  closeText: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'Inter_600SemiBold' },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: COLORS.divider,
    gap: 12,
  },
  rowUnread: { backgroundColor: COLORS.background },
  rowIcon: { fontSize: 22, marginTop: 2 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 2 },
  rowMessage: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 4, lineHeight: 17 },
  rowTime: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLORS.primary, marginTop: 8,
  },
  emptyWrap: { padding: 40, alignItems: 'center' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 6 },
  emptyHint: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary,
    textAlign: 'center', lineHeight: 18,
  },
});
