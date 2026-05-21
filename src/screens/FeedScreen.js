import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { COLORS, STATUS, LEGACY_STATUS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToQueries, autoUnsnoozeExpired } from '../services/queryService';
import { exportQueries } from '../services/exportService';
import QueryCard from '../components/QueryCard';
import FilterTabs from '../components/FilterTabs';
import EmptyState from '../components/EmptyState';
import LoadingState from '../components/LoadingState';
import ExportButton from '../components/ExportButton';
import NotificationBell from '../components/NotificationBell';

// Grouped filter key for the dispatch pipeline (covers both states).
// Other tabs map 1:1 to a single status.
const FILTER_IN_DISPATCH = '__in_dispatch';
const DISPATCH_GROUP = [
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED,
];

// Statuses we treat as "fully completed" — used to limit how many of these
// the salesperson sees (their job's done on these; the rest is history).
const COMPLETED_STATUSES = [STATUS.COMPLETED, LEGACY_STATUS.SUCCESSFUL];
const SALES_COMPLETED_LIMIT = 10;

const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: STATUS.OPEN_QUERY, label: 'Open' },
  { key: STATUS.CLAIMED_BY_SALES, label: 'Claimed' },
  { key: STATUS.SNOOZED, label: 'Snoozed' },
  { key: STATUS.WON_PENDING_ACCOUNTS, label: 'Booked' },
  { key: STATUS.PENDING_VERIFICATION, label: 'Verifying' },
  { key: STATUS.VERIFICATION_FAILED, label: 'Failed' },
  { key: FILTER_IN_DISPATCH, label: 'Dispatch' },
  { key: STATUS.COMPLETED, label: 'Completed' },
  { key: STATUS.LOST_CANCELLED, label: 'Lost' },
];

function matchesFilter(query, filterKey) {
  if (filterKey === 'all') return true;
  if (filterKey === FILTER_IN_DISPATCH) return DISPATCH_GROUP.includes(query.status);
  return query.status === filterKey;
}

export default function FeedScreen({ navigation }) {
  const { logout, userName, isOwner, isSalesperson } = useAuth();
  const [queries, setQueries] = useState([]);
  // Default to "Open" — the queries waiting to be claimed. This is what
  // salespersons need to see first; owners can flip to "All" if they want
  // the wider view.
  const [activeFilter, setActiveFilter] = useState(STATUS.OPEN_QUERY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToQueries((data) => {
      setQueries(data);
      setLoading(false);
      setRefreshing(false);
    });

    // Auto-unsnooze expired queries on mount
    autoUnsnoozeExpired().catch(console.error);

    return () => unsubscribe();
  }, []);

  // Salesperson view: keep ALL active-stage queries (Booked → Verifying →
  // Verified → Partial), so the salesperson can track each query's progress.
  // But cap completed queries to the most recent SALES_COMPLETED_LIMIT — old
  // wins still appear in My Stats, no need to clutter the feed indefinitely.
  let visibleQueries = queries;
  if (isSalesperson) {
    const recentCompletedIds = new Set(
      queries
        .filter(q => COMPLETED_STATUSES.includes(q.status))
        .sort((a, b) => {
          const ta = (a.completedAt?.getTime?.() || a.createdAt?.getTime?.() || 0);
          const tb = (b.completedAt?.getTime?.() || b.createdAt?.getTime?.() || 0);
          return tb - ta;
        })
        .slice(0, SALES_COMPLETED_LIMIT)
        .map(q => q.id)
    );
    visibleQueries = queries.filter(q =>
      !COMPLETED_STATUSES.includes(q.status) || recentCompletedIds.has(q.id)
    );
  }

  const filteredQueries = visibleQueries.filter(q => matchesFilter(q, activeFilter));

  const tabsWithCounts = FILTER_TABS.map(tab => ({
    ...tab,
    count: visibleQueries.filter(q => matchesFilter(q, tab.key)).length,
  }));

  const handleQueryPress = useCallback((query) => {
    navigation.navigate('QueryDetail', { queryId: query.id, query });
  }, [navigation]);

  const handleExport = async () => {
    await exportQueries(filteredQueries, activeFilter);
  };

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log Out', style: 'destructive', onPress: () => logout() },
      ]
    );
  };

  const onRefresh = () => {
    setRefreshing(true);
    // Auto-unsnooze on pull-to-refresh too. Data itself is real-time via Firestore.
    autoUnsnoozeExpired().catch(console.error);
    setTimeout(() => setRefreshing(false), 800);
  };

  if (loading) return <LoadingState />;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Sales Tracker</Text>
          <Text style={styles.headerSubtitle}>Hi, {userName || 'User'}</Text>
        </View>
        <View style={styles.headerActions}>
          <NotificationBell />
          <ExportButton onExport={handleExport} label="Export" />
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutIcon}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Filter Tabs */}
      <FilterTabs
        tabs={tabsWithCounts}
        activeTab={activeFilter}
        onTabChange={setActiveFilter}
      />

      {/* Query List */}
      <FlatList
        data={filteredQueries}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <QueryCard query={item} onPress={handleQueryPress} />
        )}
        contentContainerStyle={[
          styles.listContent,
          filteredQueries.length === 0 && styles.emptyList,
        ]}
        ListEmptyComponent={
          <EmptyState
            title="No queries found"
            message={activeFilter === 'all'
              ? 'Tap the button below to create your first query.'
              : `No ${(FILTER_TABS.find(t => t.key === activeFilter)?.label || '').toLowerCase()} queries right now.`}
          />
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[COLORS.primary]} />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('NewQuery')}
        activeOpacity={0.8}
      >
        <Text style={styles.fabText}>+ New Query</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: SAFE_TOP + 8,
    paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: COLORS.primary,
  },
  headerSubtitle: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoutBtn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  logoutIcon: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSecondary,
  },
  listContent: {
    paddingVertical: 8,
    paddingBottom: 80,
  },
  emptyList: {
    flex: 1,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
  fabText: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.white,
  },
});
