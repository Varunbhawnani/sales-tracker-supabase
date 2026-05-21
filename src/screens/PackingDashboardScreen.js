import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { COLORS, STATUS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { useGodownFilter } from '../contexts/GodownFilterContext';
import { subscribeToQueriesByStatuses, markPacked, undoPacked } from '../services/queryService';
import StatusBadge from '../components/StatusBadge';
import TierBadge from '../components/TierBadge';
import FilterTabs from '../components/FilterTabs';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

// The packing dashboard subscribes to verified+completed queries so the
// "In Dispatch" tab (read-only) can show items that have already been packed
// and are waiting on the dispatch team. The "To Pack" tab is the editable
// list the packer actually acts on.
const PACKING_VISIBLE_STATUSES = [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.COMPLETED];
const UNDO_WINDOW_MS = 3 * 60 * 1000;

const TABS = [
  { key: 'to_pack',     label: 'To Pack' },
  { key: 'in_dispatch', label: 'In Dispatch (view only)' },
];

export default function PackingDashboardScreen({ navigation }) {
  const { logout, userName } = useAuth();
  const { filterQueries } = useGodownFilter();
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('to_pack');
  // Tick state so the 3-min undo countdown re-renders every 5 sec.
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = subscribeToQueriesByStatuses(PACKING_VISIBLE_STATUSES, (data) => {
      setQueries(data);
      setLoading(false);
      setRefreshing(false);
    });
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  // Godown scope applied once; both tabs derive from the filtered list.
  const scopedQueries = useMemo(() => filterQueries(queries), [queries, filterQueries]);
  const toPack = useMemo(
    () => scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH && !q.isPacked),
    [scopedQueries],
  );
  const inDispatch = useMemo(
    () => scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH && q.isPacked),
    [scopedQueries],
  );

  const tabsWithCounts = TABS.map((t) => ({
    ...t,
    count: t.key === 'to_pack' ? toPack.length : inDispatch.length,
  }));

  const list = tab === 'to_pack' ? toPack : inDispatch;

  const handleToggle = async (q) => {
    try {
      if (q.isPacked) {
        await undoPacked(q.id);
        Toast.show({ type: 'info', text1: 'Undone — back to To Pack', position: 'bottom' });
      } else {
        await markPacked(q.id);
        Toast.show({ type: 'success', text1: 'Marked packed', text2: '3 min to undo', position: 'bottom' });
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed.');
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  if (loading) return null;

  const renderItem = ({ item }) => {
    const isOwnTab = tab === 'to_pack';
    // To Pack rows: editable; show the Mark Packed CTA (and undo if recently
    // packed). In Dispatch rows: read-only, just show the status.
    let actionEl = null;
    if (isOwnTab) {
      if (item.isPacked) {
        const packedMsAgo = item.packedAt ? Date.now() - item.packedAt.getTime() : 0;
        const undoLeftMs = Math.max(0, UNDO_WINDOW_MS - packedMsAgo);
        actionEl = undoLeftMs > 0 ? (
          <TouchableOpacity style={[styles.toggleBtn, styles.undoBtn]} onPress={() => handleToggle(item)}>
            <Text style={styles.undoText}>↩ Undo (locks in {Math.ceil(undoLeftMs / 1000)}s)</Text>
          </TouchableOpacity>
        ) : (
          <View style={[styles.toggleBtn, styles.lockedBtn]}>
            <Text style={styles.lockedText}>🔒 Locked — handed off to dispatch</Text>
          </View>
        );
      } else {
        actionEl = (
          <TouchableOpacity style={[styles.toggleBtn, styles.packBtn]} onPress={() => handleToggle(item)}>
            <Text style={styles.packBtnText}>✓ Mark Packed</Text>
          </TouchableOpacity>
        );
      }
    } else {
      // Read-only badge for items that have moved to the dispatch team's queue.
      actionEl = (
        <View style={[styles.toggleBtn, styles.viewOnlyBtn]}>
          <Text style={styles.viewOnlyText}>📦 Awaiting dispatch (view only)</Text>
        </View>
      );
    }

    return (
      <View style={[styles.card, item.isPacked && styles.cardPacked]}>
        <View style={styles.cardTop}>
          <StatusBadge status={item.status} />
          {item.isPacked && (
            <Text style={[styles.metaText, { color: COLORS.completed }]}>
              ✅ Packed{item.packedByName ? ` by ${item.packedByName}` : ''}
            </Text>
          )}
        </View>
        <View style={styles.nameRow}>
          <Text style={styles.customerName} numberOfLines={1}>{item.customerName || 'Unknown'}</Text>
          {item.customerCategory && <TierBadge category={item.customerCategory} style={{ marginLeft: 6 }} />}
        </View>

        <View style={styles.qtyRow}>
          <View style={styles.qtyPill}><Text style={styles.qtyValue}>{item.cartoons || 0}</Text><Text style={styles.qtyLabel}>cartons</Text></View>
          <View style={styles.qtyPill}><Text style={styles.qtyValue}>{item.lots || 0}</Text><Text style={styles.qtyLabel}>lots</Text></View>
        </View>

        {item.claimedBy && <Text style={styles.metaText}>Sales: {item.claimedBy.name}</Text>}

        {actionEl}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Packing Dashboard</Text>
          <Text style={styles.headerSubtitle}>Hi, {userName || 'User'}</Text>
        </View>
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={() => navigation?.navigate?.('Responsibilities')}
        >
          <Text style={styles.logoutText}>📋 My Role</Text>
        </TouchableOpacity>
        <NotificationBell style={{ marginRight: 8 }} />
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{toPack.length}</Text>
          <Text style={styles.statLabel}>To Pack</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.warning }]}>{inDispatch.length}</Text>
          <Text style={styles.statLabel}>In Dispatch</Text>
        </View>
      </View>

      <FilterTabs tabs={tabsWithCounts} activeTab={tab} onTabChange={setTab} />

      <FlatList
        data={list}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, list.length === 0 && styles.emptyList]}
        ListEmptyComponent={
          <EmptyState
            title="All clear!"
            message={tab === 'to_pack' ? 'Nothing waiting to pack.' : 'Nothing currently with dispatch.'}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 800); }}
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 8 },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  logoutBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.background },
  logoutText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  statBox: { flex: 1, backgroundColor: COLORS.surface, borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 22, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary },
  statLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary, marginTop: 2 },
  list: { padding: 16, paddingBottom: 40 },
  emptyList: { flex: 1 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10 },
  cardPacked: { borderLeftWidth: 4, borderLeftColor: COLORS.warning, opacity: 0.95 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  customerName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flexShrink: 1 },
  qtyRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  qtyPill: { flexDirection: 'row', alignItems: 'baseline', gap: 6, backgroundColor: COLORS.background, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  qtyValue: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  qtyLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  metaText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 6 },
  toggleBtn: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginTop: 6 },
  packBtn: { backgroundColor: COLORS.primary },
  packBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
  undoBtn: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border },
  undoText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  lockedBtn: { backgroundColor: COLORS.background },
  lockedText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  viewOnlyBtn: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.divider },
  viewOnlyText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
});
