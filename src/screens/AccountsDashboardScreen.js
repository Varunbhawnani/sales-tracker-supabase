import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { COLORS, STATUS, SAFE_TOP, DEFAULT_SLA } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import {
  subscribeToQueriesByStatuses,
  addInvoiceEntry,
  accountsUpdateQuantity,
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

const ENTRY_BADGE = {
  pending: { bg: '#FEF3C7', fg: '#92400E', label: '⏳ Pending' },
  verified: { bg: '#DCFCE7', fg: '#166534', label: '✅ Verified' },
  failed: { bg: '#FEE2E2', fg: '#991B1B', label: '❌ Failed' },
};

export default function AccountsDashboardScreen() {
  const { logout, userName } = useAuth();
  const [allQueries, setAllQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('pending');
  const [slaDays, setSlaDays] = useState(DEFAULT_SLA.accountsDays);

  // Sheet states
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [showInvoiceSheet, setShowInvoiceSheet] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceCartoons, setInvoiceCartoons] = useState('');
  const [invoiceLots, setInvoiceLots] = useState('');
  const [showFlagSheet, setShowFlagSheet] = useState(false);
  const [flagNote, setFlagNote] = useState('');
  const [showCancelSheet, setShowCancelSheet] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [showQtySheet, setShowQtySheet] = useState(false);
  const [editCartoons, setEditCartoons] = useState('');
  const [editLots, setEditLots] = useState('');
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
    const pending = allQueries.filter(q => [STATUS.WON_PENDING_ACCOUNTS, STATUS.PENDING_VERIFICATION].includes(q.status)).length;
    const failed = allQueries.filter(q => q.status === STATUS.VERIFICATION_FAILED).length;
    const verified = allQueries.filter(q =>
      [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED].includes(q.status)
    ).length;
    return { pending, failed, verified, total: allQueries.length };
  }, [allQueries]);

  const filteredQueries = useMemo(() => {
    let f = allQueries;
    if (activeTab === 'pending') f = f.filter(q => [STATUS.WON_PENDING_ACCOUNTS, STATUS.PENDING_VERIFICATION].includes(q.status));
    else if (activeTab === 'verified') f = f.filter(q => [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED].includes(q.status));
    else if (activeTab === 'failed') f = f.filter(q => q.status === STATUS.VERIFICATION_FAILED);
    return [...f].sort((a, b) => (b.wonAt?.getTime() || b.createdAt?.getTime() || 0) - (a.wonAt?.getTime() || a.createdAt?.getTime() || 0));
  }, [allQueries, activeTab]);

  const tabsWithCounts = TABS.map(t => ({
    ...t,
    count: t.key === 'pending' ? stats.pending
      : t.key === 'verified' ? stats.verified
      : t.key === 'failed' ? stats.failed
      : stats.total,
  }));

  // ─── Handlers ─────────────────────────────────────────────────────────
  const openAddInvoice = (q) => {
    setSelectedQuery(q);
    setInvoiceNumber('');
    // Pre-fill cartoons/lots with the REMAINING (un-invoiced) quantity.
    const verifiedCartoons = (q.invoiceEntries || []).filter(e => e.status !== 'failed').reduce((s, e) => s + (e.cartoons || 0), 0);
    const verifiedLots = (q.invoiceEntries || []).filter(e => e.status !== 'failed').reduce((s, e) => s + (e.lots || 0), 0);
    setInvoiceCartoons(String(Math.max(0, (q.cartoons || 0) - verifiedCartoons)));
    setInvoiceLots(String(Math.max(0, (q.lots || 0) - verifiedLots)));
    setShowInvoiceSheet(true);
  };

  const openEditQty = (q) => {
    setSelectedQuery(q);
    setEditCartoons(String(q.cartoons || 0));
    setEditLots(String(q.lots || 0));
    setShowQtySheet(true);
  };

  const handleSubmitInvoice = async () => {
    if (!invoiceNumber.trim()) { Alert.alert('Required', 'Enter the Tally Invoice Number.'); return; }
    const c = Number(invoiceCartoons) || 0;
    const l = Number(invoiceLots) || 0;
    if (c + l <= 0) { Alert.alert('Required', 'Enter at least 1 cartoon or 1 lot for this invoice.'); return; }
    setSubmitting(true);
    try {
      await addInvoiceEntry(selectedQuery.id, invoiceNumber.trim(), c, l);
      setShowInvoiceSheet(false);
      Toast.show({ type: 'success', text1: 'Invoice added — verifying…', position: 'bottom' });
    } catch (e) {
      Alert.alert('Cannot add invoice', e.message || 'Failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveQty = async () => {
    setSubmitting(true);
    try {
      await accountsUpdateQuantity(selectedQuery.id, Number(editCartoons) || 0, Number(editLots) || 0);
      setShowQtySheet(false);
      Toast.show({ type: 'success', text1: 'Quantity updated', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed.');
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
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelFailed = async () => {
    setSubmitting(true);
    try {
      await cancelVerificationFailed(selectedQuery.id, cancelNote.trim() || 'Cancelled by accounts');
      setShowCancelSheet(false);
      Toast.show({ type: 'info', text1: 'Query cancelled', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed.');
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

  // ─── Render ───────────────────────────────────────────────────────────
  const renderItem = ({ item }) => {
    const isPendingNoEntries = item.status === STATUS.WON_PENDING_ACCOUNTS;
    const isVerifying = item.status === STATUS.PENDING_VERIFICATION;
    const isFailed = item.status === STATUS.VERIFICATION_FAILED;
    const isVerified = [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED].includes(item.status);
    const isLocked = (item.invoiceAttemptCount || 0) >= 3;

    const entries = item.invoiceEntries || [];
    const verifiedCartoons = entries.filter(e => e.status === 'verified').reduce((s, e) => s + (e.cartoons || 0), 0);
    const verifiedLots = entries.filter(e => e.status === 'verified').reduce((s, e) => s + (e.lots || 0), 0);

    return (
      <View style={[styles.card, isFailed && styles.cardFailed, isVerified && styles.cardVerified]}>
        <View style={styles.cardTop}>
          <StatusBadge status={item.status} />
          {item.invoiceAttemptCount > 0 && (
            <Text style={[styles.attemptText, isLocked && { color: COLORS.danger, fontFamily: 'Inter_700Bold' }]}>
              Attempt {item.invoiceAttemptCount} of 3
            </Text>
          )}
        </View>

        <View style={styles.nameRow}>
          <Text style={styles.customerName} numberOfLines={1}>{item.customerName || 'Unknown'}</Text>
          {item.customerCategory && <TierBadge category={item.customerCategory} style={{ marginLeft: 6 }} />}
        </View>

        {/* Quantity block (editable) */}
        <View style={styles.qtyRow}>
          <Text style={styles.qtyText}>
            <Text style={styles.qtyLabel}>Cartoons: </Text>
            <Text style={styles.qtyValue}>{item.cartoons || 0}</Text>
          </Text>
          <Text style={styles.qtyText}>
            <Text style={styles.qtyLabel}>Lots: </Text>
            <Text style={styles.qtyValue}>{item.lots || 0}</Text>
          </Text>
          {!isVerified && !isLocked && (
            <TouchableOpacity onPress={() => openEditQty(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.editBtn}>✏️ Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Coverage hint */}
        {entries.length > 0 && (
          <Text style={styles.coverageText}>
            Verified: {verifiedCartoons}/{item.cartoons || 0} cartoons · {verifiedLots}/{item.lots || 0} lots
          </Text>
        )}

        {item.claimedBy && <Text style={styles.metaText}>Sales: {item.claimedBy.name}</Text>}

        {/* Invoice entries list */}
        {entries.length > 0 && (
          <View style={styles.entriesBlock}>
            {entries.map((e, idx) => {
              const badge = ENTRY_BADGE[e.status] || ENTRY_BADGE.pending;
              return (
                <View key={idx} style={styles.entryRow}>
                  <View style={[styles.entryBadge, { backgroundColor: badge.bg }]}>
                    <Text style={[styles.entryBadgeText, { color: badge.fg }]}>{badge.label}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.entryInvoice}>{e.invoiceNo}</Text>
                    <Text style={styles.entryQty}>
                      {(e.cartoons || 0) > 0 ? `${e.cartoons} cartoon${e.cartoons > 1 ? 's' : ''}` : ''}
                      {(e.cartoons || 0) > 0 && (e.lots || 0) > 0 ? ' · ' : ''}
                      {(e.lots || 0) > 0 ? `${e.lots} lot${e.lots > 1 ? 's' : ''}` : ''}
                    </Text>
                    {e.status === 'failed' && e.verificationError && (
                      <Text style={styles.entryError}>{e.verificationError}</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Verification timeout warning */}
        {isVerifying && (() => {
          const submittedAt = item.verificationTimestamp?.getTime() || 0;
          if (!submittedAt) return null;
          const minutesElapsed = (Date.now() - submittedAt) / (1000 * 60);
          if (minutesElapsed >= 30) {
            return <View style={[styles.errorBanner, { backgroundColor: '#FFF0F0' }]}><Text style={[styles.errorText, { color: COLORS.danger }]}>🔴 Awaiting verification for {Math.round(minutesElapsed)} min — bridge may be down.</Text></View>;
          }
          if (minutesElapsed >= 10) {
            return <View style={[styles.errorBanner, { backgroundColor: '#FFF8E1' }]}><Text style={[styles.errorText, { color: COLORS.warning }]}>⏳ Awaiting verification for {Math.round(minutesElapsed)} min…</Text></View>;
          }
          return null;
        })()}

        {/* Auth-failure banner */}
        {isVerifying && (item.authFailureCount > 0) && (
          <View style={[styles.errorBanner, { backgroundColor: '#FFF0F0' }]}>
            <Text style={[styles.errorText, { color: COLORS.danger }]}>
              🔐 Tally auth failed {item.authFailureCount}× — escalate to admin.
            </Text>
          </View>
        )}

        {/* Locked state */}
        {isLocked && !isVerified && (
          <View style={[styles.errorBanner, { backgroundColor: '#FFE0E0' }]}>
            <Text style={[styles.errorText, { color: COLORS.danger }]}>🔒 Locked after 3 failed attempts. Escalate to owner to unlock.</Text>
          </View>
        )}

        {/* Action buttons */}
        {!isLocked && (isPendingNoEntries || isVerifying || isFailed) && (
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.actionBtn, styles.primaryBtn]} onPress={() => openAddInvoice(item)}>
              <Text style={styles.actionText}>+ Add Invoice</Text>
            </TouchableOpacity>
            {isFailed && (
              <TouchableOpacity style={[styles.actionBtn, styles.flagBtn]} onPress={() => { setSelectedQuery(item); setFlagNote(''); setShowFlagSheet(true); }}>
                <Text style={styles.actionText}>Flag to Sales</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {!isLocked && isFailed && (
          <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn, { marginTop: 8 }]} onPress={() => { setSelectedQuery(item); setCancelNote(''); setShowCancelSheet(true); }}>
            <Text style={styles.actionText}>Cancel as Lost</Text>
          </TouchableOpacity>
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
        <View style={styles.statBox}><Text style={styles.statValue}>{stats.pending}</Text><Text style={styles.statLabel}>Pending</Text></View>
        <View style={styles.statBox}><Text style={[styles.statValue, { color: COLORS.completed }]}>{stats.verified}</Text><Text style={styles.statLabel}>Verified</Text></View>
        <View style={styles.statBox}><Text style={[styles.statValue, { color: COLORS.danger }]}>{stats.failed}</Text><Text style={styles.statLabel}>Failed</Text></View>
        <View style={styles.statBox}><Text style={[styles.statValue, { color: COLORS.primary }]}>{stats.total}</Text><Text style={styles.statLabel}>Total</Text></View>
      </View>

      <FilterTabs tabs={tabsWithCounts} activeTab={activeTab} onTabChange={setActiveTab} />

      <FlatList
        data={filteredQueries}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, filteredQueries.length === 0 && styles.emptyList]}
        ListEmptyComponent={<EmptyState title={loading ? 'Loading...' : 'All clear!'} message={loading ? 'Fetching data...' : `No ${activeTab} queries.`} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 800); }} colors={[COLORS.primary]} />}
        showsVerticalScrollIndicator={false}
      />

      {/* Add Invoice sheet */}
      <BottomSheet visible={showInvoiceSheet} title="Add Invoice for this Query" onClose={() => setShowInvoiceSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetHint}>
          Target: {selectedQuery?.cartoons || 0} cartoons · {selectedQuery?.lots || 0} lots.
          You can split into multiple invoices — each is verified separately.
        </Text>
        <Text style={styles.sheetLabel}>Invoice Number *</Text>
        <TextInput style={styles.sheetInput} placeholder="e.g. INV-2026-100" placeholderTextColor={COLORS.textTertiary}
          value={invoiceNumber} onChangeText={setInvoiceNumber} autoCapitalize="characters" autoFocus />
        <View style={styles.sheetRow}>
          <View style={styles.sheetCol}>
            <Text style={styles.sheetLabel}>Cartoons in this invoice</Text>
            <TextInput style={styles.sheetInput} placeholder="0" placeholderTextColor={COLORS.textTertiary}
              value={invoiceCartoons} onChangeText={t => setInvoiceCartoons(t.replace(/[^0-9]/g, ''))} keyboardType="numeric" />
          </View>
          <View style={styles.sheetCol}>
            <Text style={styles.sheetLabel}>Lots in this invoice</Text>
            <TextInput style={styles.sheetInput} placeholder="0" placeholderTextColor={COLORS.textTertiary}
              value={invoiceLots} onChangeText={t => setInvoiceLots(t.replace(/[^0-9]/g, ''))} keyboardType="numeric" />
          </View>
        </View>
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.pendingVerification }]} onPress={handleSubmitInvoice} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Add for verification</Text>}
        </TouchableOpacity>
      </BottomSheet>

      {/* Edit Quantity sheet */}
      <BottomSheet visible={showQtySheet} title="Edit Cartoons / Lots" onClose={() => setShowQtySheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetHint}>
          Update if the salesperson's number was wrong. New verifications use these values.
        </Text>
        <View style={styles.sheetRow}>
          <View style={styles.sheetCol}>
            <Text style={styles.sheetLabel}>Cartoons</Text>
            <TextInput style={styles.sheetInput} placeholder="0" placeholderTextColor={COLORS.textTertiary}
              value={editCartoons} onChangeText={t => setEditCartoons(t.replace(/[^0-9]/g, ''))} keyboardType="numeric" autoFocus />
          </View>
          <View style={styles.sheetCol}>
            <Text style={styles.sheetLabel}>Lots</Text>
            <TextInput style={styles.sheetInput} placeholder="0" placeholderTextColor={COLORS.textTertiary}
              value={editLots} onChangeText={t => setEditLots(t.replace(/[^0-9]/g, ''))} keyboardType="numeric" />
          </View>
        </View>
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.primary }]} onPress={handleSaveQty} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Save</Text>}
        </TouchableOpacity>
      </BottomSheet>

      {/* Flag back sheet */}
      <BottomSheet visible={showFlagSheet} title="Flag Back to Sales" onClose={() => setShowFlagSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetLabel}>Note for Sales Team</Text>
        <TextInput style={[styles.sheetInput, { minHeight: 60 }]} placeholder="Describe the issue..." placeholderTextColor={COLORS.textTertiary}
          value={flagNote} onChangeText={setFlagNote} multiline />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.warning }]} onPress={handleFlagBack} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Flag Back</Text>}
        </TouchableOpacity>
      </BottomSheet>

      {/* Cancel sheet */}
      <BottomSheet visible={showCancelSheet} title="Cancel as Lost" onClose={() => setShowCancelSheet(false)}>
        <Text style={styles.sheetCustomer}>{selectedQuery?.customerName}</Text>
        <Text style={styles.sheetWarning}>This closes the query as lost and reverses the salesperson's win.</Text>
        <Text style={styles.sheetLabel}>Reason</Text>
        <TextInput style={[styles.sheetInput, { minHeight: 60 }]} placeholder="Reason..." placeholderTextColor={COLORS.textTertiary}
          value={cancelNote} onChangeText={setCancelNote} multiline />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.lostCancelled }]} onPress={handleCancelFailed} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Cancel</Text>}
        </TouchableOpacity>
      </BottomSheet>
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
  cardFailed: { borderLeftWidth: 4, borderLeftColor: COLORS.danger },
  cardVerified: { borderLeftWidth: 4, borderLeftColor: COLORS.completed },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  attemptText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.warning },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  customerName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flexShrink: 1 },
  qtyRow: { flexDirection: 'row', gap: 16, alignItems: 'center', marginBottom: 6 },
  qtyText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  qtyLabel: { color: COLORS.textSecondary },
  qtyValue: { color: COLORS.textPrimary, fontFamily: 'Inter_700Bold' },
  editBtn: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
  coverageText: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary, marginBottom: 6 },
  metaText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 8 },
  entriesBlock: { marginTop: 4, marginBottom: 8, borderTopWidth: 1, borderTopColor: COLORS.divider, paddingTop: 8, gap: 6 },
  entryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  entryBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, alignSelf: 'flex-start' },
  entryBadgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  entryInvoice: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  entryQty: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  entryError: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.danger, marginTop: 2 },
  errorBanner: { backgroundColor: '#FFF0F0', borderRadius: 8, padding: 8, marginBottom: 8 },
  errorText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.danger },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actionBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  primaryBtn: { backgroundColor: COLORS.primary },
  flagBtn: { backgroundColor: COLORS.warning },
  cancelBtn: { backgroundColor: COLORS.lostCancelled },
  actionText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: COLORS.white },
  sheetCustomer: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, marginBottom: 8 },
  sheetHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 14, lineHeight: 16 },
  sheetWarning: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.danger, marginBottom: 12, lineHeight: 16 },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 6 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 12 },
  sheetRow: { flexDirection: 'row', gap: 10 },
  sheetCol: { flex: 1 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
