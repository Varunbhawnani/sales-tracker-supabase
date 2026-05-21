import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, AppState } from 'react-native';
import { COLORS, TIME_PERIODS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { getLeaderboardData } from '../services/statsService';
import { exportLeaderboard } from '../services/exportService';
import { subscribeToTable } from '../lib/supabase';
import GodownFilterChip from '../components/GodownFilterChip';
import { useGodownFilter } from '../contexts/GodownFilterContext';
import FilterTabs from '../components/FilterTabs';
import LeaderboardRow from '../components/LeaderboardRow';
import EmptyState from '../components/EmptyState';
import LoadingState from '../components/LoadingState';
import ExportButton from '../components/ExportButton';

const PERIOD_TABS = [
  { key: TIME_PERIODS.THIS_WEEK, label: 'Week' },
  { key: TIME_PERIODS.THIS_MONTH, label: 'Month' },
  { key: TIME_PERIODS.THIS_YEAR, label: 'Year' },
  { key: TIME_PERIODS.ALL_TIME, label: 'All Time' },
];

const PERIOD_LABELS = {
  [TIME_PERIODS.ALL_TIME]: 'AllTime',
  [TIME_PERIODS.THIS_YEAR]: 'ThisYear',
  [TIME_PERIODS.THIS_MONTH]: 'ThisMonth',
  [TIME_PERIODS.THIS_WEEK]: 'ThisWeek',
};

export default function LeaderboardScreen() {
  const { userId } = useAuth();
  const { filterByUserId } = useGodownFilter();
  const [data, setData] = useState([]);
  const [period, setPeriod] = useState(TIME_PERIODS.ALL_TIME);
  const [loading, setLoading] = useState(true);

  // When the owner picks a godown, only salespeople in that godown should
  // appear on the leaderboard. Reranks live based on the filtered set so the
  // podium positions reflect the godown's ranking.
  const visibleData = filterByUserId(data).map((r, i) => ({ ...r, rank: i + 1 }));

  const inFlightRef = useRef(false);
  const dirtyRef = useRef(false);

  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (inFlightRef.current) { dirtyRef.current = true; return; }
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      dirtyRef.current = false;
      const result = await getLeaderboardData(period);
      setData(result);
    } catch (error) {
      console.error('Error loading leaderboard:', error);
    } finally {
      inFlightRef.current = false;
      if (!silent) setLoading(false);
      if (dirtyRef.current) loadData({ silent: true });
    }
  }, [period]);

  useEffect(() => { loadData(); }, [loadData]);

  // Realtime refresh: leaderboard recomputes from queries, so any queries
  // change (someone marks won, accounts edits cartoons, etc.) needs to
  // propagate without the user having to re-open the screen. Throttle is
  // built into loadData via the inFlight + dirty refs.
  useEffect(() => {
    const channel = subscribeToTable('queries', '*', () => { loadData({ silent: true }); });
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') loadData({ silent: true });
    });
    return () => { channel.unsubscribe(); appStateSub?.remove(); };
  }, [loadData]);

  const handleExport = async () => {
    await exportLeaderboard(visibleData, PERIOD_LABELS[period]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Leaderboard</Text>
          <Text style={styles.headerSubtitle}>Salesperson rankings</Text>
        </View>
        <GodownFilterChip compact style={{ marginRight: 8 }} />
        <ExportButton onExport={handleExport} label="Excel" />
      </View>

      <FilterTabs
        tabs={PERIOD_TABS}
        activeTab={period}
        onTabChange={setPeriod}
      />

      {!loading && visibleData.length >= 3 && (
        <View style={styles.podium}>
          <View style={[styles.podiumItem, styles.podiumSecond]}>
            <Text style={styles.podiumMedal}>2</Text>
            <Text style={styles.podiumName} numberOfLines={1}>{visibleData[1]?.name}</Text>
            <Text style={styles.podiumSets}>{(visibleData[1]?.totalCartoons || 0)} c · {(visibleData[1]?.totalLots || 0)} l</Text>
          </View>
          <View style={[styles.podiumItem, styles.podiumFirst]}>
            <Text style={styles.podiumMedal}>1</Text>
            <Text style={styles.podiumName} numberOfLines={1}>{visibleData[0]?.name}</Text>
            <Text style={styles.podiumSets}>{(visibleData[0]?.totalCartoons || 0)} c · {(visibleData[0]?.totalLots || 0)} l</Text>
          </View>
          <View style={[styles.podiumItem, styles.podiumThird]}>
            <Text style={styles.podiumMedal}>3</Text>
            <Text style={styles.podiumName} numberOfLines={1}>{visibleData[2]?.name}</Text>
            <Text style={styles.podiumSets}>{(visibleData[2]?.totalCartoons || 0)} c · {(visibleData[2]?.totalLots || 0)} l</Text>
          </View>
        </View>
      )}

      {loading ? (
        <LoadingState />
      ) : (
        <FlatList
          data={visibleData}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <LeaderboardRow
              item={item}
              isCurrentUser={item.id === userId || item.userId === userId}
            />
          )}
          contentContainerStyle={[
            styles.listContent,
            data.length === 0 && styles.emptyList,
          ]}
          ListEmptyComponent={
            <EmptyState
              title="No rankings yet"
              message="Leaderboard will populate as salespeople close queries."
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  podium: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end',
    paddingHorizontal: 20, paddingVertical: 16, gap: 8,
  },
  podiumItem: {
    flex: 1, alignItems: 'center', backgroundColor: COLORS.surface, borderRadius: 16, padding: 12,
    shadowColor: COLORS.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  podiumFirst: { paddingVertical: 20, backgroundColor: '#F5F0D6', borderWidth: 1.5, borderColor: '#B8A04A' },
  podiumSecond: { paddingVertical: 14, backgroundColor: '#E2E8EC' },
  podiumThird: { paddingVertical: 14, backgroundColor: '#EDF1E6' },
  podiumMedal: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.white,
    backgroundColor: COLORS.primary, width: 32, height: 32, borderRadius: 16,
    textAlign: 'center', lineHeight: 32, overflow: 'hidden', marginBottom: 8,
  },
  podiumName: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, textAlign: 'center', marginBottom: 4 },
  podiumSets: { fontSize: 12, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  listContent: { paddingVertical: 8, paddingBottom: 20 },
  emptyList: { flex: 1 },
});
