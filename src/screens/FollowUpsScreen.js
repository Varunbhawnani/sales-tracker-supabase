import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { COLORS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToFollowUps, resolveFollowUp } from '../services/queryService';
import { relativeTime, formatDateIST } from '../utils/timeUtils';
import EmptyState from '../components/EmptyState';
import LoadingState from '../components/LoadingState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

const FILTER_TABS = [
  { key: 'all',     label: 'All' },
  { key: 'booked',  label: 'From Booked' },
  { key: 'snoozed', label: 'From Snoozed' },
];

export default function FollowUpsScreen({ navigation }) {
  const { userId, isOwner } = useAuth();
  const [followUps, setFollowUps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const unsub = subscribeToFollowUps((data) => {
      setFollowUps(data);
      setLoading(false);
      setRefreshing(false);
    });
    return () => unsub();
  }, []);

  const filtered = useMemo(() => {
    if (filter === 'all') return followUps;
    return followUps.filter(q => q.followUpOrigin === filter);
  }, [followUps, filter]);

  const handleOpenQuery = useCallback((query) => {
    navigation.navigate('QueryDetail', { queryId: query.id, query });
  }, [navigation]);

  const handleResolve = useCallback(async (queryId) => {
    try {
      await resolveFollowUp(queryId);
      Toast.show({ type: 'success', text1: 'Follow-up resolved', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to resolve.');
    }
  }, []);

  if (loading) return <LoadingState />;

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => handleOpenQuery(item)}
      activeOpacity={0.7}
    >
      <View style={styles.cardTop}>
        <View style={[
          styles.originBadge,
          item.followUpOrigin === 'booked' ? styles.originBooked : styles.originSnoozed,
        ]}>
          <Text style={styles.originBadgeText}>
            {item.followUpOrigin === 'booked' ? '📦 From Booked' : '⏰ From Snoozed'}
          </Text>
        </View>
        <Text style={styles.timeAgo}>{relativeTime(item.lastActivityAt || item.createdAt)}</Text>
      </View>

      <Text style={styles.customerName} numberOfLines={1}>{item.customerName}</Text>

      <Text style={styles.followUpText} numberOfLines={4}>{item.followUpNote}</Text>

      <View style={styles.metaRow}>
        {item.claimedBy && (
          <Text style={styles.metaText}>Sales: {item.claimedBy.name}</Text>
        )}
        {item.followUpOrigin === 'snoozed' && item.followUpDate && (
          <Text style={styles.metaText}>
            Follow-up: {item.followUpDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </Text>
        )}
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.resolveBtn]}
          onPress={(e) => { e.stopPropagation?.(); handleResolve(item.id); }}
        >
          <Text style={styles.resolveBtnText}>✓ Mark Resolved</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.openBtn]}
          onPress={() => handleOpenQuery(item)}
        >
          <Text style={styles.openBtnText}>Open Query →</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );

  const counts = {
    all: followUps.length,
    booked: followUps.filter(q => q.followUpOrigin === 'booked').length,
    snoozed: followUps.filter(q => q.followUpOrigin === 'snoozed').length,
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Follow-Ups</Text>
          <Text style={styles.headerSubtitle}>
            {isOwner ? 'All team follow-ups' : 'Things waiting on you'}
          </Text>
        </View>
        <NotificationBell />
      </View>

      <View style={styles.filterRow}>
        {FILTER_TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, filter === t.key && styles.tabActive]}
            onPress={() => setFilter(t.key)}
          >
            <Text style={[styles.tabLabel, filter === t.key && styles.tabLabelActive]}>
              {t.label} {counts[t.key] > 0 && (
                <Text style={styles.tabCount}>({counts[t.key]})</Text>
              )}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, filtered.length === 0 && styles.emptyList]}
        ListEmptyComponent={
          <EmptyState
            title="No follow-ups"
            message={filter === 'all'
              ? 'When you mark a query Booked with a follow-up note or Snooze it, it shows up here.'
              : `No ${filter === 'booked' ? 'from-booked' : 'from-snoozed'} follow-ups right now.`}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => setRefreshing(true) /* will be reset by next data callback */}
            colors={[COLORS.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    gap: 12,
  },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  filterRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.divider,
  },
  tab: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20,
    backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border,
  },
  tabActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tabLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  tabLabelActive: { color: COLORS.white },
  tabCount: { fontSize: 11, fontFamily: 'Inter_400Regular' },

  list: { padding: 16, paddingBottom: 40 },
  emptyList: { flex: 1 },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 14, padding: 14, marginBottom: 10,
    shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  originBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  originBooked: { backgroundColor: '#DCFCE7' },
  originSnoozed: { backgroundColor: '#FEF3C7' },
  originBadgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  timeAgo: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },

  customerName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 6 },
  followUpText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, lineHeight: 18, marginBottom: 10 },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10 },
  metaText: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },

  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  resolveBtn: { backgroundColor: COLORS.completed },
  resolveBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: COLORS.white },
  openBtn: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border },
  openBtnText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
});
