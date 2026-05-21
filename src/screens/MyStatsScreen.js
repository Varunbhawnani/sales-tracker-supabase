import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
} from 'react-native';
import { COLORS, TIME_PERIODS, STATUS, LEGACY_STATUS, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { getMyStats } from '../services/statsService';
import { getQueriesByUser } from '../services/queryService';
import { formatSets, formatPercentage } from '../utils/formatUtils';
import { formatDateOnly } from '../utils/timeUtils';
import FilterTabs from '../components/FilterTabs';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import LoadingState from '../components/LoadingState';

const PERIOD_TABS = [
  { key: TIME_PERIODS.THIS_WEEK,  label: 'Week' },
  { key: TIME_PERIODS.THIS_MONTH, label: 'Month' },
  { key: TIME_PERIODS.THIS_YEAR,  label: 'Year' },
  { key: TIME_PERIODS.ALL_TIME,   label: 'All Time' },
];

const WON_STATUSES = [
  STATUS.WON_PENDING_ACCOUNTS, STATUS.PENDING_VERIFICATION,
  STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED,
  LEGACY_STATUS.SUCCESSFUL,
];

export default function MyStatsScreen() {
  const { userId, userName } = useAuth();
  const [stats, setStats] = useState(null);
  const [recentQueries, setRecentQueries] = useState([]);
  const [period, setPeriod] = useState(TIME_PERIODS.ALL_TIME);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, queriesData] = await Promise.all([
        getMyStats(userId, period),
        getQueriesByUser(userId),
      ]);
      setStats(statsData);
      setRecentQueries(queriesData);
    } catch (error) {
      console.error('Error loading my stats:', error);
    } finally {
      setLoading(false);
    }
  }, [userId, period]);

  useEffect(() => {
    if (userId) loadData();
  }, [loadData, userId]);

  if (loading) return <LoadingState />;

  const successRate = stats?.totalClaimed > 0
    ? formatPercentage(stats.totalSuccessful, stats.totalClaimed)
    : '0.0%';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Stats</Text>
        <Text style={styles.headerSubtitle}>{userName}</Text>
      </View>

      <FilterTabs tabs={PERIOD_TABS} activeTab={period} onTabChange={setPeriod} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.statsRow}>
          <StatCard label="Claimed" value={stats?.totalClaimed || 0} />
          <StatCard label="Successful" value={stats?.totalSuccessful || 0} color={COLORS.successful} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label="Unsuccessful" value={stats?.totalUnsuccessful || 0} color={COLORS.unsuccessful} />
          <StatCard label="Cartoons" value={stats?.totalCartoons || 0} color={COLORS.primary} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label="Lots" value={stats?.totalLots || 0} color={COLORS.primary} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label="Success Rate" value={successRate} color={COLORS.primary} />
        </View>

        <Text style={styles.sectionTitle}>Recent Activity</Text>

        {recentQueries.length === 0 ? (
          <EmptyState
            title="No activity yet"
            message="Claim and close queries to see your activity here."
            style={{ paddingVertical: 30 }}
          />
        ) : (
          recentQueries.slice(0, 20).map((q) => (
            <View key={q.id} style={styles.activityRow}>
              <View style={styles.activityLeft}>
                <Text style={styles.activityParty} numberOfLines={2}>{q.customerName || 'Unknown'}</Text>
                <Text style={styles.activityDate}>
                  {q.createdAt ? formatDateOnly(q.createdAt) : '—'}
                </Text>
              </View>
              <View style={styles.activityRight}>
                {WON_STATUSES.includes(q.status) && (
                  <Text style={styles.activitySets}>{q.requiredSets || 0} Sets</Text>
                )}
                <StatusBadge status={q.status} />
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  content: { padding: 16, paddingBottom: 40 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  sectionTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary, marginTop: 20, marginBottom: 14 },
  activityRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: COLORS.surface, borderRadius: 12, padding: 14, marginBottom: 8,
  },
  activityLeft: { flex: 1, marginRight: 10 },
  activityParty: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 2 },
  activityDate: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary },
  activityRight: { alignItems: 'flex-end', gap: 6 },
  activitySets: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.successful },
});
