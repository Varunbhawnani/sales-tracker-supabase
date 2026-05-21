import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { COLORS, STATUS, LEGACY_STATUS, ROLES, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToQueries, adminResetInvoiceAttempts, flagBackToSales } from '../services/queryService';
import { subscribeToUsers } from '../services/authService';
import { getLeaderboardData } from '../services/statsService';
import { subscribeToSettings } from '../services/settingsService';
import { relativeTime } from '../utils/timeUtils';
import GodownFilterChip from '../components/GodownFilterChip';
import { useGodownFilter } from '../contexts/GodownFilterContext';
import FilterTabs from '../components/FilterTabs';
import BarChart from '../components/BarChart';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import LoadingState from '../components/LoadingState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

const VIEW_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'sales', label: 'Sales Team' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'dispatch', label: 'Dispatch' },
];

const WON_STATUSES = [
  STATUS.WON_PENDING_ACCOUNTS, STATUS.PENDING_VERIFICATION,
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED,
  LEGACY_STATUS.SUCCESSFUL,
];
const LOST_STATUSES = [STATUS.LOST_CANCELLED, LEGACY_STATUS.UNSUCCESSFUL];
const OPEN_STATUSES = [STATUS.OPEN_QUERY, STATUS.CLAIMED_BY_SALES, STATUS.SNOOZED, LEGACY_STATUS.PENDING, LEGACY_STATUS.CLAIMED];
const ACCOUNTS_PIPELINE = [STATUS.WON_PENDING_ACCOUNTS, STATUS.PENDING_VERIFICATION, STATUS.VERIFICATION_FAILED];
const DISPATCH_PIPELINE = [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED];

// 6-step pipeline: Open → Claimed → Booked → Verified → Packed → Shipped
const PIPELINE_STAGES = ['Open', 'Claimed', 'Booked', 'Verified', 'Packed', 'Shipped'];
// stageIndex now takes the WHOLE query so it can read is_packed too.
function stageIndex(query) {
  const { status, isPacked } = query;
  switch (status) {
    case STATUS.OPEN_QUERY: return 0;
    case STATUS.CLAIMED_BY_SALES:
    case STATUS.SNOOZED:
    case LEGACY_STATUS.PENDING:
    case LEGACY_STATUS.CLAIMED:
      return 1;
    case STATUS.WON_PENDING_ACCOUNTS:
    case STATUS.PENDING_VERIFICATION:
    case STATUS.VERIFICATION_FAILED:
      return 2;
    case STATUS.VERIFIED_PENDING_DISPATCH:
      // After verification, the order goes to packing. Once packed, it
      // sits in the dispatch queue. So:
      return isPacked ? 4 : 3;
    case STATUS.PARTIALLY_DISPATCHED:
    case STATUS.COMPLETED:
    case LEGACY_STATUS.SUCCESSFUL:
      return 5;
    case STATUS.LOST_CANCELLED:
    case LEGACY_STATUS.UNSUCCESSFUL:
      return -1;
    default:
      return 0;
  }
}

const PipelineBar = React.memo(function PipelineBar({ query }) {
  const idx = stageIndex(query);
  const isLost = idx === -1;
  const ageMs = query.createdAt ? (Date.now() - query.createdAt.getTime()) : 0;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // "Stuck" if still pre-shipped (idx < 5) after 5 days
  const stuckColor = ageDays > 5 && idx < 5 ? COLORS.warning : COLORS.primary;

  return (
    <View style={pipelineStyles.card}>
      <View style={pipelineStyles.topRow}>
        <Text style={pipelineStyles.name} numberOfLines={1}>{query.customerName || 'Unknown'}</Text>
        <StatusBadge status={query.status} />
      </View>
      <View style={pipelineStyles.barRow}>
        {PIPELINE_STAGES.map((label, i) => (
          <View key={i} style={pipelineStyles.segmentWrap}>
            <View style={[
              pipelineStyles.segment,
              isLost ? { backgroundColor: COLORS.lostCancelled, opacity: i === 0 ? 1 : 0.25 }
                     : i <= idx ? { backgroundColor: stuckColor } : { backgroundColor: COLORS.divider },
            ]} />
            <Text style={[pipelineStyles.segmentLabel, i === idx && { color: stuckColor, fontFamily: 'Inter_600SemiBold' }]}>
              {label}
            </Text>
          </View>
        ))}
      </View>
      <Text style={pipelineStyles.timeText}>
        Raised {relativeTime(query.createdAt)}
        {ageDays > 5 && idx < 4 && !isLost && ' · ⚠ stuck'}
      </Text>
    </View>
  );
});

const pipelineStyles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface, borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  name: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flex: 1, marginRight: 8 },
  barRow: { flexDirection: 'row', gap: 4, marginBottom: 6 },
  segmentWrap: { flex: 1, alignItems: 'center' },
  segment: { width: '100%', height: 6, borderRadius: 3 },
  segmentLabel: { fontSize: 9, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 4 },
  timeText: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
});

export default function OwnerDashboardScreen() {
  const { logout } = useAuth();
  const { filterQueries, filterUsers, filterByUserId } = useGodownFilter();
  const [queries, setQueries] = useState([]);
  const [users, setUsers] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [activeView, setActiveView] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [thresholdDays, setThresholdDays] = useState(30);

  const loadLeaderboard = useCallback(async () => {
    try { setLeaderboard(await getLeaderboardData()); } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    const unsubQ = subscribeToQueries((data) => {
      setQueries(data);
      setLoading(false);
      // Refresh the leaderboard whenever queries change so the team-throughput
      // card mirrors live cartoons/lots changes from accounts edits, mark-won
      // events, etc. The Owner Dashboard previously did this once at mount.
      loadLeaderboard();
    });
    const unsubU = subscribeToUsers((list) => setUsers(list));
    const unsubS = subscribeToSettings((s) => setThresholdDays(s.gonequietThresholdDays || 30));
    return () => { unsubQ(); unsubU(); unsubS(); };
  }, [loadLeaderboard]);

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  // Godown scope applied here once; every derived view (stats, pipeline,
  // alerts, per-salesperson breakdown) reads from this filtered list.
  const scopedQueries = useMemo(() => filterQueries(queries), [queries, filterQueries]);
  const scopedLeaderboard = useMemo(() => filterByUserId(leaderboard), [leaderboard, filterByUserId]);

  const stats = useMemo(() => {
    const queries = scopedQueries; // shadow so the existing block below reads from scope
    const total = queries.length;
    const open = queries.filter(q => OPEN_STATUSES.includes(q.status)).length;
    const won = queries.filter(q => WON_STATUSES.includes(q.status)).length;
    const lost = queries.filter(q => LOST_STATUSES.includes(q.status)).length;
    const pendingAccounts = queries.filter(q => ACCOUNTS_PIPELINE.includes(q.status)).length;
    const pendingDispatch = queries.filter(q => DISPATCH_PIPELINE.includes(q.status)).length;
    const completed = queries.filter(q => q.status === STATUS.COMPLETED || q.status === LEGACY_STATUS.SUCCESSFUL).length;
    // Cartoons + lots are the live unit. We sum each separately so the UI can
    // show two distinct figures, and we also keep a combined "totalUnitsSold"
    // for the headline stat card. Legacy queries (cartoons + lots both zero)
    // fall back to required_sets so historical pre-cartoons rows still
    // contribute a number rather than vanishing.
    const wonQueries = queries.filter(q => WON_STATUSES.includes(q.status));
    const totalCartoonsSold = wonQueries.reduce((s, q) => s + (q.cartoons || 0), 0);
    const totalLotsSold = wonQueries.reduce((s, q) => s + (q.lots || 0), 0);
    const totalUnitsSold = wonQueries.reduce((s, q) => {
      const c = q.cartoons || 0;
      const l = q.lots || 0;
      return s + ((c + l) > 0 ? (c + l) : (q.requiredSets || 0));
    }, 0);
    const verificationFailed = queries.filter(q => q.status === STATUS.VERIFICATION_FAILED).length;
    const partiallyDispatched = queries.filter(q => q.status === STATUS.PARTIALLY_DISPATCHED).length;
    const dispatchedQueries = queries.filter(q =>
      [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED].includes(q.status)
    );
    const totalCartoonsDispatched = dispatchedQueries
      .filter(q => q.status === STATUS.COMPLETED)
      .reduce((s, q) => s + (q.cartoons || 0), 0);
    const totalLotsDispatched = dispatchedQueries
      .filter(q => q.status === STATUS.COMPLETED)
      .reduce((s, q) => s + (q.lots || 0), 0);

    // ─── Packing throughput ──────────────────────────────────────────────────
    // A query is "in packing" once verified and accounts handed it off — that
    // is, status = verified_pending_dispatch AND is_packed = false.
    // Once is_packed flips true it's "ready to ship" (still verified_pending_dispatch
    // until dispatch ticks it off). We also count anything past dispatch as packed.
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - 7); startOfWeek.setHours(0, 0, 0, 0);

    const packingQueue = queries.filter(q =>
      q.status === STATUS.VERIFIED_PENDING_DISPATCH && !q.isPacked
    ).length;
    const readyToShip = queries.filter(q =>
      q.status === STATUS.VERIFIED_PENDING_DISPATCH && q.isPacked
    ).length;
    const packedToday = queries.filter(q =>
      q.packedAt && q.packedAt.getTime() >= startOfToday.getTime()
    ).length;
    const packedThisWeek = queries.filter(q =>
      q.packedAt && q.packedAt.getTime() >= startOfWeek.getTime()
    ).length;

    return {
      total, open, won, lost, pendingAccounts, pendingDispatch, completed,
      totalUnitsSold, totalCartoonsSold, totalLotsSold,
      totalCartoonsDispatched, totalLotsDispatched,
      verificationFailed, partiallyDispatched,
      packingQueue, readyToShip, packedToday, packedThisWeek,
    };
  }, [scopedQueries]);

  const pipelineData = useMemo(() => [
    { label: 'Open', value: stats.open, color: COLORS.openQuery },
    { label: 'Accounts', value: stats.pendingAccounts, color: COLORS.pendingVerification },
    { label: 'Packing', value: stats.packingQueue, color: COLORS.warning },
    { label: 'Dispatch', value: stats.readyToShip + stats.partiallyDispatched, color: COLORS.verifiedPendingDispatch },
    { label: 'Done', value: stats.completed, color: COLORS.completed },
    { label: 'Lost', value: stats.lost, color: COLORS.lostCancelled },
  ], [stats]);

  // Apply godown scope to the team listings as well — when the owner picks a
  // godown, the per-salesperson breakdown below only includes godown members.
  const scopedUsers = useMemo(() => filterUsers(users), [users, filterUsers]);
  const salesTeamUsers = scopedUsers.filter(u => u.role === ROLES.SALESPERSON && u.isActive !== false);
  const accountsUsers = scopedUsers.filter(u => u.role === ROLES.ACCOUNTS && u.isActive !== false);
  const dispatchUsers = scopedUsers.filter(
    u => (u.role === ROLES.DISPATCH || u.role === ROLES.OPERATIONS || u.role === ROLES.PACKING)
      && u.isActive !== false
  );

  const salespersonStats = useMemo(() => {
    return salesTeamUsers.map(u => {
      const userQueries = scopedQueries.filter(q => q.claimedBy?.userId === u.id);
      const wonQ = userQueries.filter(q => WON_STATUSES.includes(q.status));
      const lostQ = userQueries.filter(q => LOST_STATUSES.includes(q.status));
      const cartoons = wonQ.reduce((s, q) => s + (q.cartoons || 0), 0);
      const lots = wonQ.reduce((s, q) => s + (q.lots || 0), 0);
      const total = wonQ.length + lostQ.length;
      const rate = total > 0 ? Math.round((wonQ.length / total) * 100) : 0;
      return {
        id: u.id, name: u.name, username: u.username,
        claimed: userQueries.length, won: wonQ.length, lost: lostQ.length,
        cartoons, lots, rate,
        open: userQueries.filter(q => OPEN_STATUSES.includes(q.status)).length,
      };
    }).sort((a, b) => (b.cartoons + b.lots) - (a.cartoons + a.lots));
  }, [scopedQueries, salesTeamUsers]);

  // Queries raised in the last 20 days, newest first
  const recentPipeline = useMemo(() => {
    const cutoff = Date.now() - 20 * 24 * 60 * 60 * 1000;
    return scopedQueries
      .filter(q => q.createdAt && q.createdAt.getTime() >= cutoff)
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }, [scopedQueries]);

  // Queries locked after 5 failed invoice attempts
  const lockedQueries = useMemo(
    () => scopedQueries.filter(q => (q.invoiceAttemptCount || 0) >= 5),
    [scopedQueries]
  );

  const handleUnlock = async (queryId) => {
    try {
      await adminResetInvoiceAttempts(queryId);
      Toast.show({ type: 'success', text1: 'Query unlocked', text2: 'Accounts can try again.', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to unlock.');
    }
  };

  const handleFlagBack = async (queryId) => {
    try {
      await flagBackToSales(queryId, 'Returned to sales after 5 failed invoice attempts');
      Toast.show({ type: 'info', text1: 'Flagged back to sales', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to flag back.');
    }
  };

  if (loading) return <LoadingState />;

  const renderOverview = () => (
    <>
      <View style={styles.statsRow}>
        <StatCard label="Total Queries" value={stats.total} />
        <StatCard
          label="Booked"
          value={`${stats.totalCartoonsSold}c · ${stats.totalLotsSold}l`}
          color={COLORS.completed}
        />
      </View>
      <View style={styles.statsRow}>
        <StatCard label="Completed" value={stats.completed} color={COLORS.completed} />
        <StatCard label="Lost" value={stats.lost} color={COLORS.lostCancelled} />
      </View>

      <View style={styles.section}>
        <BarChart data={pipelineData} title="Pipeline Overview" />
        <View style={styles.miniStatsRow}>
          <View style={[styles.miniStat, { borderLeftColor: COLORS.openQuery }]}>
            <Text style={styles.miniStatValue}>{stats.open}</Text>
            <Text style={styles.miniStatLabel}>Open</Text>
          </View>
          <View style={[styles.miniStat, { borderLeftColor: COLORS.pendingVerification }]}>
            <Text style={styles.miniStatValue}>{stats.pendingAccounts}</Text>
            <Text style={styles.miniStatLabel}>Accounts</Text>
          </View>
          <View style={[styles.miniStat, { borderLeftColor: COLORS.warning }]}>
            <Text style={styles.miniStatValue}>{stats.packingQueue}</Text>
            <Text style={styles.miniStatLabel}>Packing</Text>
          </View>
          <View style={[styles.miniStat, { borderLeftColor: COLORS.verifiedPendingDispatch }]}>
            <Text style={styles.miniStatValue}>{stats.readyToShip + stats.partiallyDispatched}</Text>
            <Text style={styles.miniStatLabel}>Dispatch</Text>
          </View>
        </View>
      </View>

      {/* ─── Packing team throughput ─── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Packing Team</Text>
        <View style={styles.statsRow}>
          <StatCard label="In Queue" value={stats.packingQueue} color={COLORS.warning} />
          <StatCard label="Ready to Ship" value={stats.readyToShip} color={COLORS.verifiedPendingDispatch} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label="Packed Today" value={stats.packedToday} color={COLORS.completed} />
          <StatCard label="Packed This Week" value={stats.packedThisWeek} color={COLORS.primary} />
        </View>
      </View>

      <View style={styles.insightsSection}>
        <Text style={styles.sectionTitle}>Quick Insights</Text>
        {stats.pendingAccounts > 0 && (
          <InsightRow color={COLORS.pendingVerification} title={`${stats.pendingAccounts} in Accounts queue`} desc="Awaiting invoice entry or verification." />
        )}
        {stats.verificationFailed > 0 && (
          <InsightRow color={COLORS.danger} title={`${stats.verificationFailed} verification failures`} desc="Invoice not found in Tally — needs re-entry." />
        )}
        {stats.packingQueue > 0 && (
          <InsightRow color={COLORS.warning} title={`${stats.packingQueue} awaiting packing`} desc="Verified by accounts, waiting for the packing team." />
        )}
        {stats.readyToShip > 0 && (
          <InsightRow color={COLORS.verifiedPendingDispatch} title={`${stats.readyToShip} ready to ship`} desc="Packed and waiting for dispatch." />
        )}
        {stats.partiallyDispatched > 0 && (
          <InsightRow color={COLORS.verifiedPendingDispatch} title={`${stats.partiallyDispatched} partially dispatched`} desc="Some units shipped; the rest are still pending." />
        )}
        {salespersonStats.length > 0 && (
          <InsightRow color={COLORS.primary} title={`Top: ${salespersonStats[0]?.name}`} desc={`${salespersonStats[0]?.cartoons}c · ${salespersonStats[0]?.lots}l · ${salespersonStats[0]?.won} booked · ${salespersonStats[0]?.rate}% rate`} />
        )}
        {stats.open === 0 && stats.pendingAccounts === 0 && stats.pendingDispatch === 0 && (
          <InsightRow color={COLORS.completed} title="Everything looks great!" desc="No urgent items right now." />
        )}
      </View>

      {/* ─── Locked queries (5 invoice attempts failed) ─── */}
      {lockedQueries.length > 0 && (
        <View style={styles.lockedSection}>
          <Text style={styles.sectionTitle}>🔒 Locked Queries ({lockedQueries.length})</Text>
          <Text style={styles.lockedHint}>
            These queries are locked after 5 failed invoice-verification attempts. Unlock to give accounts another 5 tries, or flag back to sales for correction.
          </Text>
          {lockedQueries.map(q => (
            <View key={q.id} style={[styles.alertCard, { borderLeftColor: COLORS.danger }]}>
              <Text style={styles.alertTitle}>{q.customerName}</Text>
              <Text style={styles.alertDesc}>
                Last tried: {q.tallyInvoiceNumber || 'N/A'}
                {q.verificationError ? ` · ${q.verificationError.split('—')[0].trim()}` : ''}
              </Text>
              <Text style={styles.alertMeta}>Sales: {q.claimedBy?.name || '—'} · Raised {relativeTime(q.createdAt)}</Text>
              <View style={styles.lockedActions}>
                <TouchableOpacity style={[styles.lockedBtn, styles.unlockBtn]} onPress={() => handleUnlock(q.id)}>
                  <Text style={styles.lockedBtnText}>Unlock (5 more tries)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.lockedBtn, styles.flagBackBtn]} onPress={() => handleFlagBack(q.id)}>
                  <Text style={styles.lockedBtnText}>Flag Back to Sales</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ─── Recent Pipeline (last 20 days) ─── */}
      {recentPipeline.length > 0 && (
        <View style={styles.pipelineSection}>
          <Text style={styles.sectionTitle}>Recent Pipeline (last 20 days)</Text>
          <Text style={styles.pipelineHint}>{recentPipeline.length} queries — newest first. Yellow segments highlight queries stuck > 5 days.</Text>
          {recentPipeline.map(q => <PipelineBar key={q.id} query={q} />)}
        </View>
      )}
    </>
  );

  const renderSalesTeam = () => (
    <>
      <Text style={styles.sectionTitle}>Sales Team ({salesTeamUsers.length} active)</Text>
      {salespersonStats.length === 0 ? (
        <Text style={styles.emptyText}>No salespersons found.</Text>
      ) : (
        salespersonStats.map(sp => (
          <View key={sp.id} style={styles.userCard}>
            <View style={styles.userCardHeader}>
              <View>
                <Text style={styles.userCardName}>{sp.name}</Text>
                <Text style={styles.userCardMeta}>@{sp.username}</Text>
              </View>
              <View style={[styles.rateBadge, { backgroundColor: sp.rate >= 70 ? COLORS.completed : sp.rate >= 40 ? COLORS.warning : COLORS.danger }]}>
                <Text style={styles.rateBadgeText}>{sp.rate}%</Text>
              </View>
            </View>
            <View style={styles.userStatsRow}>
              <View style={styles.userStatItem}>
                <Text style={styles.userStatValue}>{sp.claimed}</Text>
                <Text style={styles.userStatLabel}>Claimed</Text>
              </View>
              <View style={styles.userStatItem}>
                <Text style={[styles.userStatValue, { color: COLORS.completed }]}>{sp.won}</Text>
                <Text style={styles.userStatLabel}>Booked</Text>
              </View>
              <View style={styles.userStatItem}>
                <Text style={[styles.userStatValue, { color: COLORS.lostCancelled }]}>{sp.lost}</Text>
                <Text style={styles.userStatLabel}>Lost</Text>
              </View>
              <View style={styles.userStatItem}>
                <Text style={[styles.userStatValue, { color: COLORS.primary }]}>{sp.cartoons}</Text>
                <Text style={styles.userStatLabel}>Cartons</Text>
              </View>
              <View style={styles.userStatItem}>
                <Text style={[styles.userStatValue, { color: COLORS.primary }]}>{sp.lots}</Text>
                <Text style={styles.userStatLabel}>Lots</Text>
              </View>
              <View style={styles.userStatItem}>
                <Text style={[styles.userStatValue, { color: COLORS.openQuery }]}>{sp.open}</Text>
                <Text style={styles.userStatLabel}>Open</Text>
              </View>
            </View>
          </View>
        ))
      )}
    </>
  );

  const renderAccounts = () => (
    <>
      <Text style={styles.sectionTitle}>Accounts Overview</Text>
      <View style={styles.statsRow}>
        <StatCard label="In Queue" value={stats.pendingAccounts} color={COLORS.pendingVerification} />
        <StatCard label="Failed" value={stats.verificationFailed} color={COLORS.danger} />
      </View>
      <View style={styles.statsRow}>
        <StatCard label="Verified" value={scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH || q.status === STATUS.PARTIALLY_DISPATCHED || q.status === STATUS.COMPLETED).length} color={COLORS.completed} />
        <StatCard label="Completed" value={stats.completed} color={COLORS.completed} />
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Accounts Team ({accountsUsers.length})</Text>
      {accountsUsers.length === 0 ? (
        <Text style={styles.emptyText}>No accounts users registered.</Text>
      ) : (
        accountsUsers.map(u => (
          <View key={u.id} style={styles.userCard}>
            <Text style={styles.userCardName}>{u.name}</Text>
            <Text style={styles.userCardMeta}>@{u.username} · Active</Text>
          </View>
        ))
      )}

      {stats.verificationFailed > 0 && (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>⚠ Verification Failures</Text>
          {scopedQueries.filter(q => q.status === STATUS.VERIFICATION_FAILED).slice(0, 5).map(q => (
            <View key={q.id} style={[styles.alertCard, { borderLeftColor: COLORS.danger }]}>
              <Text style={styles.alertTitle}>{q.customerName}</Text>
              <Text style={styles.alertDesc}>{q.verificationError || 'Invoice not found'}</Text>
              <Text style={styles.alertMeta}>Invoice: {q.tallyInvoiceNumber} · Sales: {q.claimedBy?.name || '—'}</Text>
            </View>
          ))}
        </>
      )}
    </>
  );

  const renderDispatch = () => {
    return (
      <>
        <Text style={styles.sectionTitle}>Dispatch Overview</Text>
        <View style={styles.statsRow}>
          <StatCard label="Pending" value={scopedQueries.filter(q => q.status === STATUS.VERIFIED_PENDING_DISPATCH).length} color={COLORS.verifiedPendingDispatch} />
          <StatCard label="Partial" value={stats.partiallyDispatched} color={COLORS.warning} />
        </View>
        <View style={styles.statsRow}>
          <StatCard
            label="Shipped (Cartons)"
            value={stats.totalCartoonsDispatched}
            color={COLORS.primary}
          />
          <StatCard
            label="Shipped (Lots)"
            value={stats.totalLotsDispatched}
            color={COLORS.primary}
          />
        </View>

        <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Dispatch Team ({dispatchUsers.length})</Text>
        {dispatchUsers.length === 0 ? (
          <Text style={styles.emptyText}>No dispatch users registered.</Text>
        ) : (
          dispatchUsers.map(u => (
            <View key={u.id} style={styles.userCard}>
              <Text style={styles.userCardName}>{u.name}</Text>
              <Text style={styles.userCardMeta}>@{u.username} · Active</Text>
            </View>
          ))
        )}

        {stats.partiallyDispatched > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 16 }]}>In-Progress Orders</Text>
            {scopedQueries.filter(q => q.status === STATUS.PARTIALLY_DISPATCHED).slice(0, 5).map(q => (
              <View key={q.id} style={[styles.alertCard, { borderLeftColor: COLORS.warning }]}>
                <Text style={styles.alertTitle}>{q.customerName}</Text>
                <Text style={styles.alertDesc}>{q.cartoons || 0} cartons · {q.lots || 0} lots — partial</Text>
              </View>
            ))}
          </>
        )}
      </>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Dashboard</Text>
          <Text style={styles.headerSubtitle}>Business Overview</Text>
        </View>
        <GodownFilterChip compact style={{ marginRight: 8 }} />
        <NotificationBell style={{ marginRight: 8 }} />
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <FilterTabs tabs={VIEW_TABS} activeTab={activeView} onTabChange={setActiveView} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {activeView === 'overview' && renderOverview()}
        {activeView === 'sales' && renderSalesTeam()}
        {activeView === 'accounts' && renderAccounts()}
        {activeView === 'dispatch' && renderDispatch()}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

function InsightRow({ color, title, desc }) {
  return (
    <View style={[styles.insightCard, { borderLeftColor: color }]}>
      <View style={[styles.insightDot, { backgroundColor: color }]} />
      <View style={styles.insightContent}>
        <Text style={styles.insightTitle}>{title}</Text>
        <Text style={styles.insightDesc}>{desc}</Text>
      </View>
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
  content: { padding: 16, paddingBottom: 40 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  section: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 18, marginBottom: 12, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },
  miniStatsRow: { flexDirection: 'row', gap: 8, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.divider },
  miniStat: { flex: 1, borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4 },
  miniStatValue: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary },
  miniStatLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary, marginTop: 2 },
  sectionTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary, marginBottom: 14 },
  insightsSection: { marginTop: 4 },
  insightCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderLeftWidth: 4, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 4, elevation: 1 },
  insightDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  insightContent: { flex: 1 },
  insightTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 2 },
  insightDesc: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, lineHeight: 16 },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, textAlign: 'center', paddingVertical: 20 },
  userCard: { backgroundColor: COLORS.surface, borderRadius: 14, padding: 16, marginBottom: 10, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },
  userCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  userCardName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  userCardMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 2 },
  rateBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  rateBadgeText: { fontSize: 13, fontFamily: 'Inter_700Bold', color: COLORS.white },
  userStatsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  userStatItem: { alignItems: 'center', flex: 1 },
  userStatValue: { fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary },
  userStatLabel: { fontSize: 10, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary, marginTop: 2 },
  alertCard: { backgroundColor: COLORS.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderLeftWidth: 4, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 4, elevation: 1 },
  alertTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 2 },
  alertDesc: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary },
  alertMeta: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 4 },
  // Locked + pipeline sections (Overview tab)
  lockedSection: { marginTop: 16 },
  lockedHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 12, lineHeight: 16 },
  lockedActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  lockedBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  unlockBtn: { backgroundColor: COLORS.primary },
  flagBackBtn: { backgroundColor: COLORS.warning },
  lockedBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: COLORS.white },
  pipelineSection: { marginTop: 16 },
  pipelineHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 12 },
});
