import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { COLORS, STATUS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { useGodownFilter } from '../contexts/GodownFilterContext';
import { subscribeToQueriesByStatuses, markDispatched, undoDispatched } from '../services/queryService';
import StatusBadge from '../components/StatusBadge';
import TierBadge from '../components/TierBadge';
import FilterTabs from '../components/FilterTabs';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

// Mirror of PackingDashboardScreen but from the dispatch team's perspective.
// "To Dispatch" is editable (items that have been packed). "In Packing" is
// read-only — useful so dispatch knows what's coming next.
const DISPATCH_VISIBLE_STATUSES = [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.COMPLETED];
const UNDO_WINDOW_MS = 3 * 60 * 1000;

const TABS = [
  { key: 'to_dispatch', label: 'To Dispatch' },
  { key: 'in_packing',  label: 'In Packing (view only)' },
  { key: 'completed',   label: 'Completed' },
];

export default function DispatchDashboardScreen({ navigation }) {
  const { logout, userName } = useAuth();
  const { filterQueries } = useGodownFilter();
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('to_dispatch');
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = subscribeToQueriesByStatuses(DISPATCH_VISIBLE_STATUSES, (data) => {
      setQueries(data);
      setLoading(false);
      setRefreshing(false);
    });
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  // Same godown scope as the packing dashboard — applied once, every tab
  // derives from it.
  const scopedQueries = useMemo(() => filterQueries(queries), [queries, filterQueries]);
  const toDispatch = useMemo(
    () => scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH && q.isPacked),
    [scopedQueries],
  );
  const inPacking = useMemo(
    () => scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH && !q.isPacked),
    [scopedQueries],
  );
  const completed = useMemo(
    () => scopedQueries.filter(q => q.status === STATUS.COMPLETED),
    [scopedQueries],
  );

  const tabsWithCounts = TABS.map((t) => ({
    ...t,
    count:
      t.key === 'to_dispatch' ? toDispatch.length
      : t.key === 'in_packing' ? inPacking.length
      : completed.length,
  }));

  const list = tab === 'to_dispatch' ? toDispatch
    : tab === 'in_packing' ? inPacking
    : completed;

  const handleDispatchToggle = async (q) => {
    try {
      if (q.status === STATUS.COMPLETED) {
        await undoDispatched(q.id);
        Toast.show({ type: 'info', text1: 'Undone — back to To Dispatch', position: 'bottom' });
      } else {
        await markDispatched(q.id);
        Toast.show({ type: 'success', text1: 'Marked dispatched', text2: '3 min to undo', position: 'bottom' });
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
    let actionEl = null;

    if (tab === 'to_dispatch') {
      actionEl = (
        <TouchableOpacity style={[styles.toggleBtn, styles.dispatchBtn]} onPress={() => handleDispatchToggle(item)}>
          <Text style={styles.dispatchText}>✓ Mark Dispatched</Text>
        </TouchableOpacity>
      );
    } else if (tab === 'in_packing') {
      // Read-only: dispatch can see what packing is working on but not edit.
      actionEl = (
        <View style={[styles.toggleBtn, styles.viewOnlyBtn]}>
          <Text style={styles.viewOnlyText}>📥 With packing (view only)</Text>
        </View>
      );
    } else {
      // Completed tab — show undo only if within window.
      const dispMsAgo = item.dispatchedAt ? Date.now() - item.dispatchedAt.getTime() : 0;
      const undoLeftMs = Math.max(0, UNDO_WINDOW_MS - dispMsAgo);
      actionEl = undoLeftMs > 0 ? (
        <TouchableOpacity style={[styles.toggleBtn, styles.undoBtn]} onPress={() => handleDispatchToggle(item)}>
          <Text style={styles.undoText}>↩ Undo (locks in {Math.ceil(undoLeftMs / 1000)}s)</Text>
        </TouchableOpacity>
      ) : (
        <View style={[styles.toggleBtn, styles.lockedBtn]}>
          <Text style={styles.lockedText}>🔒 Locked — order complete</Text>
        </View>
      );
    }

    return (
      <View style={[styles.card, item.status === STATUS.COMPLETED && styles.cardCompleted]}>
        <View style={styles.cardTop}>
          <StatusBadge status={item.status} />
          {tab === 'completed' && (
            <Text style={[styles.metaText, { color: COLORS.completed }]}>
              ✅ Dispatched{item.dispatchedByName ? ` by ${item.dispatchedByName}` : ''}
            </Text>
          )}
          {tab === 'to_dispatch' && (
            <Text style={[styles.metaText, { color: COLORS.completed }]}>📦 Packed</Text>
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

        {item.packedByName && (
          <Text style={styles.metaText}>Packed by: {item.packedByName}</Text>
        )}

        {actionEl}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Dispatch Dashboard</Text>
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
          <Text style={styles.statValue}>{toDispatch.length}</Text>
          <Text style={styles.statLabel}>To Dispatch</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.warning }]}>{inPacking.length}</Text>
          <Text style={styles.statLabel}>In Packing</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.completed }]}>{completed.length}</Text>
          <Text style={styles.statLabel}>Completed</Text>
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
            message={
              tab === 'to_dispatch' ? 'Nothing waiting to dispatch.'
              : tab === 'in_packing' ? 'Nothing currently with packing.'
              : 'Nothing dispatched yet.'
            }
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
  cardCompleted: { borderLeftWidth: 4, borderLeftColor: COLORS.completed, opacity: 0.9 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  customerName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flexShrink: 1 },
  qtyRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  qtyPill: { flexDirection: 'row', alignItems: 'baseline', gap: 6, backgroundColor: COLORS.background, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  qtyValue: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  qtyLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  metaText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 6 },
  toggleBtn: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginTop: 6 },
  dispatchBtn: { backgroundColor: COLORS.primary },
  dispatchText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
  undoBtn: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border },
  undoText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  lockedBtn: { backgroundColor: COLORS.background },
  lockedText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  viewOnlyBtn: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.divider },
  viewOnlyText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
});
