import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { COLORS, STATUS, SAFE_TOP, DEFAULT_SLA } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToQueriesByStatuses, updateDispatchedSets } from '../services/queryService';
import { subscribeToSettings } from '../services/settingsService';
import StatusBadge from '../components/StatusBadge';
import TierBadge from '../components/TierBadge';
import FulfillmentBar from '../components/FulfillmentBar';
import FilterTabs from '../components/FilterTabs';
import BottomSheet from '../components/BottomSheet';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

const DISPATCH_STATUSES = [
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED,
  STATUS.COMPLETED,
];

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'partial', label: 'Partial' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

function getDispatchSla(verifiedAt, slaDays) {
  if (!verifiedAt) return { color: COLORS.textTertiary, label: '—' };
  const ts = verifiedAt.getTime();
  const elapsed = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  const pct = elapsed / slaDays;
  if (pct <= 0.5) return { color: COLORS.completed, label: `${elapsed.toFixed(1)}d` };
  if (pct <= 0.8) return { color: COLORS.warning, label: `${elapsed.toFixed(1)}d` };
  return { color: COLORS.danger, label: `${elapsed.toFixed(1)}d ⚠` };
}

export default function DispatchDashboardScreen() {
  const { logout, userName } = useAuth();
  const [allQueries, setAllQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('pending');
  const [slaDays, setSlaDays] = useState(DEFAULT_SLA.dispatchDays);

  const [selectedQuery, setSelectedQuery] = useState(null);
  const [setsInput, setSetsInput] = useState('');
  const [showDispatchSheet, setShowDispatchSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const unsubQ = subscribeToQueriesByStatuses(DISPATCH_STATUSES, (data) => {
      setAllQueries(data);
      setLoading(false);
      setRefreshing(false);
    });
    const unsubS = subscribeToSettings((s) => {
      setSlaDays(s.slaDispatchDays || DEFAULT_SLA.dispatchDays);
    });
    return () => { unsubQ(); unsubS(); };
  }, []);

  const stats = useMemo(() => {
    const pending = allQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH).length;
    const partial = allQueries.filter(q => q.status === STATUS.PARTIALLY_DISPATCHED).length;
    const completed = allQueries.filter(q => q.status === STATUS.COMPLETED).length;
    const totalSetsRequired = allQueries.reduce((s, q) => s + (q.requiredSets || 0), 0);
    const totalSetsDispatched = allQueries.reduce((s, q) => s + (q.dispatchedSets || 0), 0);
    return { pending, partial, completed, total: allQueries.length, totalSetsRequired, totalSetsDispatched };
  }, [allQueries]);

  const filteredQueries = useMemo(() => {
    switch (activeTab) {
      case 'pending': return allQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH);
      case 'partial': return allQueries.filter(q => q.status === STATUS.PARTIALLY_DISPATCHED);
      case 'completed': return allQueries.filter(q => q.status === STATUS.COMPLETED);
      default: return [...allQueries];
    }
  }, [allQueries, activeTab]);

  const tabsWithCounts = TABS.map(t => ({
    ...t,
    count: t.key === 'pending' ? stats.pending
      : t.key === 'partial' ? stats.partial
      : t.key === 'completed' ? stats.completed
      : stats.total,
  }));

  const handleOpenDispatchSheet = (q) => {
    setSelectedQuery(q);
    setSetsInput('');
    setShowDispatchSheet(true);
  };

  const handleSubmitDispatch = async () => {
    const sets = Number(setsInput);
    if (!sets || sets <= 0) {
      Alert.alert('Required', 'Please enter the number of sets shipped.');
      return;
    }
    const remaining = (selectedQuery.requiredSets || 0) - (selectedQuery.dispatchedSets || 0);
    if (sets > remaining) {
      Alert.alert('Too Many', `Only ${remaining} sets remaining.`);
      return;
    }
    setSubmitting(true);
    try {
      await updateDispatchedSets(selectedQuery.id, sets, userName);
      setShowDispatchSheet(false);
      const newTotal = (selectedQuery.dispatchedSets || 0) + sets;
      const isComplete = newTotal >= (selectedQuery.requiredSets || 0);
      Toast.show({
        type: isComplete ? 'success' : 'info',
        text1: isComplete ? 'Order Completed!' : 'Dispatch logged',
        text2: `${sets} sets shipped — ${newTotal}/${selectedQuery.requiredSets} total`,
        position: 'bottom',
      });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to log dispatch.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  const renderItem = ({ item }) => {
    const sla = getDispatchSla(item.verificationTimestamp, slaDays);
    const remaining = (item.requiredSets || 0) - (item.dispatchedSets || 0);
    const isCompleted = item.status === STATUS.COMPLETED;

    return (
      <View style={[styles.card, isCompleted && styles.cardCompleted]}>
        <View style={styles.cardTop}>
          <StatusBadge status={item.status} />
          {!isCompleted && (
            <View style={[styles.slaBadge, { backgroundColor: sla.color }]}>
              <Text style={styles.slaText}>{sla.label}</Text>
            </View>
          )}
        </View>

        <View style={styles.nameRow}>
          <Text style={styles.customerName} numberOfLines={1}>{item.customerName || 'Unknown'}</Text>
          {item.customerCategory && <TierBadge category={item.customerCategory} style={{ marginLeft: 6 }} />}
        </View>

        {item.items && item.items.length > 0 && (
          <View style={styles.itemsList}>
            {item.items.map((lineItem, idx) => (
              <View key={idx} style={styles.lineItem}>
                <Text style={styles.lineItemName} numberOfLines={1}>{lineItem.productName}</Text>
                <Text style={styles.lineItemQty}>{lineItem.quantity} sets</Text>
              </View>
            ))}
          </View>
        )}

        <FulfillmentBar dispatched={item.dispatchedSets || 0} required={item.requiredSets || 0} />

        {item.dispatchHistory && item.dispatchHistory.length > 0 && (
          <View style={styles.historySection}>
            <Text style={styles.historyTitle}>Recent Dispatches</Text>
            {item.dispatchHistory.slice(-3).reverse().map((entry, idx) => (
              <View key={idx} style={styles.historyRow}>
                <Text style={styles.historyDate}>
                  {entry.date?.toLocaleDateString?.('en-IN', { day: 'numeric', month: 'short' }) || '—'}
                </Text>
                <Text style={styles.historySets}>{entry.setsShipped} sets</Text>
                <Text style={styles.historyOp}>{entry.operator}</Text>
              </View>
            ))}
          </View>
        )}

        {!isCompleted && (
          <TouchableOpacity style={styles.dispatchBtn} onPress={() => handleOpenDispatchSheet(item)}>
            <Text style={styles.dispatchBtnText}>Log Dispatch ({remaining} remaining)</Text>
          </TouchableOpacity>
        )}
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
        <NotificationBell style={{ marginRight: 8 }} />
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{stats.pending}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.warning }]}>{stats.partial}</Text>
          <Text style={styles.statLabel}>Partial</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.completed }]}>{stats.completed}</Text>
          <Text style={styles.statLabel}>Done</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.primary }]}>{stats.totalSetsDispatched}</Text>
          <Text style={styles.statLabel}>Shipped</Text>
        </View>
      </View>

      <FilterTabs tabs={tabsWithCounts} activeTab={activeTab} onTabChange={setActiveTab} />

      <FlatList
        data={filteredQueries}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, filteredQueries.length === 0 && styles.emptyList]}
        ListEmptyComponent={
          <EmptyState
            title={loading ? 'Loading...' : 'All shipped!'}
            message={loading ? 'Fetching data...' : `No ${activeTab} orders right now.`}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              setTimeout(() => setRefreshing(false), 800);
            }}
            colors={[COLORS.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      />

      <BottomSheet visible={showDispatchSheet} title="Log Dispatch" onClose={() => setShowDispatchSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <FulfillmentBar dispatched={selectedQuery?.dispatchedSets || 0} required={selectedQuery?.requiredSets || 0} />
        <View style={{ height: 16 }} />
        <Text style={styles.sheetLabel}>Sets Shipped Today *</Text>
        <TextInput style={styles.sheetInput} placeholder={`Max: ${(selectedQuery?.requiredSets || 0) - (selectedQuery?.dispatchedSets || 0)}`} placeholderTextColor={COLORS.textTertiary} value={setsInput} onChangeText={(t) => setSetsInput(t.replace(/[^0-9]/g, ''))} keyboardType="numeric" autoFocus />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.primary }]} onPress={handleSubmitDispatch} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Dispatch</Text>}
        </TouchableOpacity>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  logoutBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.background },
  logoutText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  statBox: { flex: 1, backgroundColor: COLORS.surface, borderRadius: 12, padding: 12, alignItems: 'center', shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1 },
  statValue: { fontSize: 22, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary },
  statLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary, marginTop: 2 },
  list: { padding: 16, paddingBottom: 40 },
  emptyList: { flex: 1 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 16, marginBottom: 10, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },
  cardCompleted: { borderLeftWidth: 4, borderLeftColor: COLORS.completed, opacity: 0.8 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  slaBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  slaText: { fontSize: 11, fontFamily: 'Inter_700Bold', color: COLORS.white },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  customerName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flexShrink: 1 },
  itemsList: { marginBottom: 6 },
  lineItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  lineItemName: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, flex: 1 },
  lineItemQty: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  historySection: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.divider },
  historyTitle: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textTertiary, marginBottom: 4 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  historyDate: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, flex: 1 },
  historySets: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flex: 1, textAlign: 'center' },
  historyOp: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, flex: 1, textAlign: 'right' },
  dispatchBtn: { backgroundColor: COLORS.primary, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  dispatchBtnText: { fontSize: 13, fontFamily: 'Inter_700Bold', color: COLORS.white },
  sheetCustomer: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, marginBottom: 12 },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 16 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
