import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { COLORS, STATUS, SAFE_TOP, DEFAULT_SLA } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import {
  subscribeToQueriesByStatuses,
  submitInvoiceNumber,
  flagBackToSales,
  cancelVerificationFailed,
} from '../services/queryService';
import { subscribeToSettings } from '../services/settingsService';
import StatusBadge from '../components/StatusBadge';
import TierBadge from '../components/TierBadge';
import FilterTabs from '../components/FilterTabs';
import BottomSheet from '../components/BottomSheet';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import Toast from 'react-native-toast-message';

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'verified', label: 'Verified' },
  { key: 'failed', label: 'Failed' },
  { key: 'all', label: 'All' },
];

const ACCOUNTS_STATUSES = [
  STATUS.WON_PENDING_ACCOUNTS,
  STATUS.PENDING_VERIFICATION,
  STATUS.VERIFICATION_FAILED,
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED,
  STATUS.COMPLETED,
];

function getSlaIndicator(wonAt, slaDays) {
  if (!wonAt) return { color: COLORS.textTertiary, label: '—' };
  const ts = wonAt.getTime();
  const elapsed = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  const pct = elapsed / slaDays;
  if (pct <= 0.5) return { color: COLORS.completed, label: `${elapsed.toFixed(1)}d` };
  if (pct <= 0.8) return { color: COLORS.warning, label: `${elapsed.toFixed(1)}d` };
  return { color: COLORS.danger, label: `${elapsed.toFixed(1)}d ⚠` };
}

export default function AccountsDashboardScreen() {
  const { logout, userName } = useAuth();
  const [allQueries, setAllQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('pending');
  const [slaDays, setSlaDays] = useState(DEFAULT_SLA.accountsDays);
  const [sortNewestFirst, setSortNewestFirst] = useState(true);

  const [selectedQuery, setSelectedQuery] = useState(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [cancelNote, setCancelNote] = useState('');
  const [showInvoiceSheet, setShowInvoiceSheet] = useState(false);
  const [showFlagSheet, setShowFlagSheet] = useState(false);
  const [showCancelSheet, setShowCancelSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const unsubQ = subscribeToQueriesByStatuses(ACCOUNTS_STATUSES, (data) => {
      setAllQueries(data);
      setLoading(false);
      setRefreshing(false);
    });
    const unsubS = subscribeToSettings((s) => {
      setSlaDays(s.slaAccountsDays || DEFAULT_SLA.accountsDays);
    });
    return () => { unsubQ(); unsubS(); };
  }, []);

  const stats = useMemo(() => {
    const pending = allQueries.filter(q => q.status === STATUS.WON_PENDING_ACCOUNTS).length;
    const pendingVerification = allQueries.filter(q => q.status === STATUS.PENDING_VERIFICATION).length;
    const failed = allQueries.filter(q => q.status === STATUS.VERIFICATION_FAILED).length;
    const verified = allQueries.filter(q =>
      q.status === STATUS.VERIFIED_PENDING_DISPATCH ||
      q.status === STATUS.PARTIALLY_DISPATCHED ||
      q.status === STATUS.COMPLETED
    ).length;
    const totalProcessed = verified + failed;
    return { pending, pendingVerification, failed, verified, totalProcessed, total: allQueries.length };
  }, [allQueries]);

  const filteredQueries = useMemo(() => {
    let filtered;
    switch (activeTab) {
      case 'pending':
        filtered = allQueries.filter(q =>
          q.status === STATUS.WON_PENDING_ACCOUNTS || q.status === STATUS.PENDING_VERIFICATION
        );
        break;
      case 'verified':
        filtered = allQueries.filter(q =>
          q.status === STATUS.VERIFIED_PENDING_DISPATCH ||
          q.status === STATUS.PARTIALLY_DISPATCHED ||
          q.status === STATUS.COMPLETED
        );
        break;
      case 'failed':
        filtered = allQueries.filter(q => q.status === STATUS.VERIFICATION_FAILED);
        break;
      default:
        filtered = [...allQueries];
    }

    filtered.sort((a, b) => {
      const aT = a.wonAt?.getTime() || a.createdAt?.getTime() || 0;
      const bT = b.wonAt?.getTime() || b.createdAt?.getTime() || 0;
      return sortNewestFirst ? bT - aT : aT - bT;
    });

    return filtered;
  }, [allQueries, activeTab, sortNewestFirst]);

  const tabsWithCounts = TABS.map(t => ({
    ...t,
    count: t.key === 'pending' ? stats.pending + stats.pendingVerification
      : t.key === 'verified' ? stats.verified
      : t.key === 'failed' ? stats.failed
      : stats.total,
  }));

  const handleOpenInvoiceSheet = (q) => {
    setSelectedQuery(q);
    setInvoiceNumber(q.tallyInvoiceNumber || '');
    setShowInvoiceSheet(true);
  };

  const handleOpenFlagSheet = (q) => {
    setSelectedQuery(q);
    setFlagNote('');
    setShowFlagSheet(true);
  };

  const handleOpenCancelSheet = (q) => {
    setSelectedQuery(q);
    setCancelNote('');
    setShowCancelSheet(true);
  };

  const handleCancelFailed = async () => {
    setSubmitting(true);
    try {
      await cancelVerificationFailed(
        selectedQuery.id,
        cancelNote.trim() || 'Verification failed — cancelled by accounts',
      );
      setShowCancelSheet(false);
      Toast.show({ type: 'info', text1: 'Query cancelled', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to cancel query.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitInvoice = async () => {
    if (!invoiceNumber.trim()) {
      Alert.alert('Required', 'Please enter the Tally Invoice Number.');
      return;
    }
    setSubmitting(true);
    try {
      await submitInvoiceNumber(selectedQuery.id, invoiceNumber.trim());
      setShowInvoiceSheet(false);
      Toast.show({ type: 'success', text1: 'Invoice submitted for verification', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to submit invoice.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFlagBack = async () => {
    setSubmitting(true);
    try {
      await flagBackToSales(selectedQuery.id, flagNote.trim() || 'Flagged back by accounts');
      setShowFlagSheet(false);
      Toast.show({ type: 'info', text1: 'Flagged back to sales', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to flag back.');
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
    const sla = getSlaIndicator(item.wonAt, slaDays);
    const isFailed = item.status === STATUS.VERIFICATION_FAILED;
    const isPending = item.status === STATUS.WON_PENDING_ACCOUNTS;
    const isPendingVerification = item.status === STATUS.PENDING_VERIFICATION;
    const isVerified = [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED].includes(item.status);

    return (
      <View style={[styles.card, isFailed && styles.cardFailed, isVerified && styles.cardVerified]}>
        <View style={styles.cardTop}>
          <StatusBadge status={item.status} />
          {(isPending || isFailed || isPendingVerification) && (
            <View style={[styles.slaBadge, { backgroundColor: sla.color }]}>
              <Text style={styles.slaText}>{sla.label}</Text>
            </View>
          )}
        </View>

        <View style={styles.nameRow}>
          <Text style={styles.customerName} numberOfLines={1}>{item.customerName || 'Unknown'}</Text>
          {item.customerCategory && <TierBadge category={item.customerCategory} style={{ marginLeft: 6 }} />}
        </View>

        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{item.requiredSets || 0} Sets</Text>
          {item.projectedRevenue > 0 && (
            <Text style={styles.metaText}>₹{item.projectedRevenue.toLocaleString('en-IN')}</Text>
          )}
          {item.claimedBy && <Text style={styles.metaText}>Sales: {item.claimedBy.name}</Text>}
        </View>

        {item.items && item.items.length > 0 && (
          <Text style={styles.itemsSummary} numberOfLines={2}>
            {item.items.map(i => `${i.productName} (${i.quantity})`).join(', ')}
          </Text>
        )}

        {item.wonAt && (
          <Text style={styles.dateText}>
            Booked: {item.wonAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
        )}

        {item.tallyInvoiceNumber && (
          <Text style={styles.invoiceText}>Invoice: {item.tallyInvoiceNumber}</Text>
        )}

        {isPendingVerification && (() => {
          const submittedAt = item.verificationTimestamp?.getTime() || 0;
          if (!submittedAt) return null;
          const minutesElapsed = (Date.now() - submittedAt) / (1000 * 60);
          if (minutesElapsed >= 30) {
            return (
              <View style={[styles.errorBanner, { backgroundColor: '#FFF0F0' }]}>
                <Text style={[styles.errorText, { color: COLORS.danger }]}>
                  🔴 Awaiting verification for {Math.round(minutesElapsed)} min — Bridge may be down. Escalate to Admin.
                </Text>
              </View>
            );
          }
          if (minutesElapsed >= 10) {
            return (
              <View style={[styles.errorBanner, { backgroundColor: '#FFF8E1' }]}>
                <Text style={[styles.errorText, { color: COLORS.warning }]}>
                  ⏳ Awaiting verification for {Math.round(minutesElapsed)} min...
                </Text>
              </View>
            );
          }
          return null;
        })()}

        {isPendingVerification && (item.authFailureCount > 0) && (
          <View style={[styles.errorBanner, { backgroundColor: '#FFF0F0' }]}>
            <Text style={[styles.errorText, { color: COLORS.danger }]}>
              🔐 Tally auth failed {item.authFailureCount}×
              {item.authFailureCount >= 5 ? ' — bridge stopped retrying. ' : ' — '}
              escalate to admin.
            </Text>
          </View>
        )}

        {isFailed && item.verificationError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>⚠ {item.verificationError}</Text>
          </View>
        )}

        {/* Attempt counter — shown once at least one attempt has failed */}
        {(item.invoiceAttemptCount || 0) > 0 && (
          <Text style={[
            styles.attemptText,
            (item.invoiceAttemptCount >= 5) && { color: COLORS.danger, fontFamily: 'Inter_700Bold' },
          ]}>
            Attempt {item.invoiceAttemptCount} of 5
          </Text>
        )}

        {/* Locked state — at 5 attempts, accounts can't try again. Owner unlocks. */}
        {(item.invoiceAttemptCount || 0) >= 5 ? (
          <View style={[styles.errorBanner, { backgroundColor: '#FFE0E0' }]}>
            <Text style={[styles.errorText, { color: COLORS.danger }]}>
              🔒 Locked after 5 failed attempts. Escalate to the owner to unlock.
            </Text>
          </View>
        ) : (isPending || isFailed) && (
          <>
            <View style={styles.cardActions}>
              <TouchableOpacity style={[styles.cardBtn, styles.invoiceBtn]} onPress={() => handleOpenInvoiceSheet(item)}>
                <Text style={styles.cardBtnText}>{isFailed ? 'Re-enter Invoice' : 'Enter Invoice #'}</Text>
              </TouchableOpacity>
              {isFailed && (
                <TouchableOpacity style={[styles.cardBtn, styles.flagBtn]} onPress={() => handleOpenFlagSheet(item)}>
                  <Text style={styles.cardBtnText}>Flag to Sales</Text>
                </TouchableOpacity>
              )}
            </View>
            {isFailed && (
              <TouchableOpacity style={[styles.cardBtn, styles.cancelBtn, { marginTop: 8 }]} onPress={() => handleOpenCancelSheet(item)}>
                <Text style={styles.cardBtnText}>Cancel as Lost</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Accounts Dashboard</Text>
          <Text style={styles.headerSubtitle}>Hi, {userName || 'User'}</Text>
        </View>
        <NotificationBell style={{ marginRight: 8 }} />
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{stats.pending + stats.pendingVerification}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.completed }]}>{stats.verified}</Text>
          <Text style={styles.statLabel}>Verified</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.danger }]}>{stats.failed}</Text>
          <Text style={styles.statLabel}>Failed</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: COLORS.primary }]}>{stats.total}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
      </View>

      <FilterTabs tabs={tabsWithCounts} activeTab={activeTab} onTabChange={setActiveTab} />

      <View style={styles.sortRow}>
        <Text style={styles.countText}>{filteredQueries.length} queries</Text>
        <TouchableOpacity onPress={() => setSortNewestFirst(!sortNewestFirst)}>
          <Text style={styles.sortText}>{sortNewestFirst ? '↓ Newest first' : '↑ Oldest first'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={filteredQueries}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, filteredQueries.length === 0 && styles.emptyList]}
        ListEmptyComponent={
          <EmptyState
            title={loading ? 'Loading...' : 'All clear!'}
            message={loading ? 'Fetching data...' : `No ${activeTab} queries right now.`}
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

      <BottomSheet visible={showInvoiceSheet} title="Enter Tally Invoice Number" onClose={() => setShowInvoiceSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetLabel}>Invoice Number *</Text>
        <TextInput style={styles.sheetInput} placeholder="e.g., INV-2025-001" placeholderTextColor={COLORS.textTertiary} value={invoiceNumber} onChangeText={setInvoiceNumber} autoFocus autoCapitalize="characters" />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.pendingVerification }]} onPress={handleSubmitInvoice} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Submit for Verification</Text>}
        </TouchableOpacity>
      </BottomSheet>

      <BottomSheet visible={showFlagSheet} title="Flag Back to Sales" onClose={() => setShowFlagSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetLabel}>Note for Sales Team</Text>
        <TextInput style={[styles.sheetInput, { minHeight: 60 }]} placeholder="Describe the issue..." placeholderTextColor={COLORS.textTertiary} value={flagNote} onChangeText={setFlagNote} multiline />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.warning }]} onPress={handleFlagBack} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Flag Back</Text>}
        </TouchableOpacity>
      </BottomSheet>

      <BottomSheet visible={showCancelSheet} title="Cancel as Lost" onClose={() => setShowCancelSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetWarning}>
          This will close the query as lost and reverse the salesperson's win.
          Use this only when the invoice truly can't be verified in Tally.
        </Text>
        <Text style={styles.sheetLabel}>Reason (optional)</Text>
        <TextInput
          style={[styles.sheetInput, { minHeight: 60 }]}
          placeholder="Why are you cancelling this?"
          placeholderTextColor={COLORS.textTertiary}
          value={cancelNote}
          onChangeText={setCancelNote}
          multiline
        />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.lostCancelled }]} onPress={handleCancelFailed} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Cancel</Text>}
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
  sortRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 6 },
  countText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  sortText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
  list: { padding: 16, paddingBottom: 40 },
  emptyList: { flex: 1 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 16, marginBottom: 10, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },
  cardFailed: { borderLeftWidth: 4, borderLeftColor: COLORS.danger },
  cardVerified: { borderLeftWidth: 4, borderLeftColor: COLORS.completed },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  slaBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  slaText: { fontSize: 11, fontFamily: 'Inter_700Bold', color: COLORS.white },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  customerName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flexShrink: 1 },
  metaRow: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  metaText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary },
  itemsSummary: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginBottom: 4 },
  dateText: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginBottom: 4 },
  invoiceText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, marginBottom: 4 },
  attemptText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.warning, marginBottom: 4 },
  errorBanner: { backgroundColor: COLORS.verificationFailedBg || '#FFF0F0', borderRadius: 8, padding: 8, marginBottom: 8 },
  errorText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.danger },
  cardActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  cardBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  invoiceBtn: { backgroundColor: COLORS.primary },
  flagBtn: { backgroundColor: COLORS.warning },
  cancelBtn: { backgroundColor: COLORS.lostCancelled },
  cardBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: COLORS.white },
  sheetCustomer: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, marginBottom: 16 },
  sheetWarning: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.danger, marginBottom: 12, lineHeight: 18 },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 16 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
