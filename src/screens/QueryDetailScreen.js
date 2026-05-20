import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import PlatformDatePicker from '../components/PlatformDatePicker';
import { COLORS, STATUS } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import {
  subscribeToQuery, claimQuery, markWon, markLostCancelled,
  snoozeQuery, unsnoozeQuery,
} from '../services/queryService';
import StatusBadge from '../components/StatusBadge';
import TierBadge from '../components/TierBadge';
import BottomSheet from '../components/BottomSheet';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingState from '../components/LoadingState';
import { relativeTime, formatDateIST } from '../utils/timeUtils';
import { formatQuantity } from '../utils/formatUtils';
import Toast from 'react-native-toast-message';

export default function QueryDetailScreen({ navigation, route }) {
  const { queryId } = route.params;
  const { userId, userRole, isSalesperson } = useAuth();

  const [query, setQuery] = useState(route.params.query || null);
  const [loading, setLoading] = useState(!route.params.query);
  const [claiming, setClaiming] = useState(false);

  const [showWonSheet, setShowWonSheet] = useState(false);
  const [showLostSheet, setShowLostSheet] = useState(false);
  const [showSnoozeSheet, setShowSnoozeSheet] = useState(false);
  const [requiredSetsInput, setRequiredSetsInput] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [followUpDate, setFollowUpDate] = useState(new Date(Date.now() + 86400000));
  const [submitting, setSubmitting] = useState(false);

  const [showConfirmLost, setShowConfirmLost] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToQuery(queryId, (data) => {
      setQuery(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [queryId]);

  const handleClaim = async () => {
    setClaiming(true);
    try {
      const result = await claimQuery(queryId, userId, null, userRole);
      if (result.success) {
        Toast.show({ type: 'success', text1: 'Query claimed', position: 'bottom' });
      } else {
        Alert.alert('Already Claimed', result.message);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to claim query.');
    } finally {
      setClaiming(false);
    }
  };

  const handleMarkWon = async () => {
    const sets = requiredSetsInput ? Number(requiredSetsInput) : (query.requiredSets || 0);
    if (!sets || sets <= 0) {
      Alert.alert('Required', 'Please enter required sets.');
      return;
    }
    setSubmitting(true);
    try {
      await markWon(queryId, sets);
      setShowWonSheet(false);
      setRequiredSetsInput('');
      Toast.show({ type: 'success', text1: 'Marked as Booked!', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to update.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkLost = async () => {
    setShowConfirmLost(false);
    setSubmitting(true);
    try {
      await markLostCancelled(queryId, failureReason.trim());
      setShowLostSheet(false);
      setFailureReason('');
      Toast.show({ type: 'info', text1: 'Marked as Lost', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to update.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSnooze = async () => {
    setSubmitting(true);
    try {
      await snoozeQuery(queryId, followUpDate);
      setShowSnoozeSheet(false);
      Toast.show({
        type: 'success', text1: 'Query snoozed',
        text2: `Follow-up: ${followUpDate.toLocaleDateString('en-IN')}`,
        position: 'bottom',
      });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to snooze.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnsnooze = async () => {
    setSubmitting(true);
    try {
      await unsnoozeQuery(queryId);
      Toast.show({ type: 'success', text1: 'Query unsnoozed', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to unsnooze.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !query) return <LoadingState />;

  const isClaimedByMe = query.claimedBy?.userId === userId;
  const canClaim = query.status === STATUS.OPEN_QUERY && isSalesperson;
  const canActSales = isClaimedByMe && (query.status === STATUS.CLAIMED_BY_SALES);
  const canUnsnooze = isClaimedByMe && query.status === STATUS.SNOOZED;
  const canCancelFromSnooze = isClaimedByMe && query.status === STATUS.SNOOZED;

  const timeToWinMs = query.gamification?.timeToWinMs;
  const timeToWinDays = timeToWinMs ? (timeToWinMs / (1000 * 60 * 60 * 24)).toFixed(1) : null;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <View style={styles.statusRow}>
          <StatusBadge status={query.status} style={styles.largeBadge} />
          <Text style={styles.timeAgo}>{relativeTime(query.createdAt)}</Text>
        </View>

        <View style={styles.nameRow}>
          <Text style={styles.partyName}>{query.customerName || 'Unknown'}</Text>
          {query.customerCategory && (
            <TierBadge category={query.customerCategory} style={{ marginLeft: 8 }} />
          )}
        </View>

        <View style={styles.detailsCard}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Required Sets</Text>
            <Text style={styles.detailValue}>{formatQuantity(query.requiredSets)}</Text>
          </View>
          <Text style={styles.pairsHint}>1 Set = 8 Pairs</Text>

          {query.projectedRevenue > 0 && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Projected Revenue</Text>
              <Text style={[styles.detailValue, { color: COLORS.primaryLight }]}>
                ₹{query.projectedRevenue.toLocaleString('en-IN')}
              </Text>
            </View>
          )}

          {query.items && query.items.length > 0 && (
            <>
              <View style={styles.separator} />
              <Text style={styles.sectionLabel}>Items</Text>
              {query.items.map((item, idx) => (
                <View key={idx} style={styles.itemRow}>
                  <Text style={styles.itemName} numberOfLines={1}>{item.productName || 'Product'}</Text>
                  <Text style={styles.itemDetail}>{item.quantity} × ₹{item.unitPrice?.toLocaleString('en-IN')}</Text>
                </View>
              ))}
            </>
          )}

          {query.notes ? (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Notes</Text>
                <Text style={styles.notesText}>{query.notes}</Text>
              </View>
            </>
          ) : null}

          <View style={styles.separator} />
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Posted by</Text>
            <Text style={styles.detailValue}>{query.createdBy?.name || 'Unknown'}</Text>
          </View>
          <Text style={styles.timestamp}>{formatDateIST(query.createdAt)}</Text>

          {query.claimedBy && (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Claimed by</Text>
                <Text style={styles.detailValue}>{query.claimedBy.name}</Text>
              </View>
              {query.claimedAt && <Text style={styles.timestamp}>{formatDateIST(query.claimedAt)}</Text>}
            </>
          )}

          {query.status === STATUS.SNOOZED && query.followUpDate && (
            <>
              <View style={styles.separator} />
              <View style={styles.snoozeInfo}>
                <Text style={styles.snoozeLabel}>⏰ Snoozed — Follow-up</Text>
                <Text style={styles.snoozeDate}>
                  {query.followUpDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
              </View>
            </>
          )}

          {query.wonAt && (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Booked at</Text>
                <Text style={styles.detailValue}>{formatDateIST(query.wonAt)}</Text>
              </View>
              {timeToWinDays && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Time to Book</Text>
                  <Text style={styles.detailValue}>{timeToWinDays} days</Text>
                </View>
              )}
            </>
          )}

          {query.tallyInvoiceNumber && (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Invoice #</Text>
                <Text style={styles.detailValue}>{query.tallyInvoiceNumber}</Text>
              </View>
            </>
          )}
          {query.verificationError && (
            <Text style={[styles.timestamp, { color: COLORS.danger }]}>{query.verificationError}</Text>
          )}
          {query.verificationNote && (
            <Text style={[styles.timestamp, { color: COLORS.warning }]}>Note: {query.verificationNote}</Text>
          )}

          {(query.status === STATUS.PARTIALLY_DISPATCHED || query.status === STATUS.COMPLETED) && (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Dispatched</Text>
                <Text style={styles.detailValue}>{query.dispatchedSets || 0} / {query.requiredSets || 0} sets</Text>
              </View>
            </>
          )}

          {query.closedAt && (
            <>
              <View style={styles.separator} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Closed</Text>
                <Text style={styles.detailValue}>{formatDateIST(query.closedAt)}</Text>
              </View>
              {query.failureReason && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Reason</Text>
                  <Text style={[styles.detailValue, { color: COLORS.unsuccessful }]}>{query.failureReason}</Text>
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {canClaim && (
        <View style={styles.actionBar}>
          <TouchableOpacity style={styles.claimButton} onPress={handleClaim} disabled={claiming} activeOpacity={0.8}>
            {claiming ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.claimButtonText}>Claim This Query</Text>}
          </TouchableOpacity>
        </View>
      )}

      {canActSales && (
        <View style={styles.actionBar}>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: COLORS.wonPendingAccounts }]} onPress={() => setShowWonSheet(true)} activeOpacity={0.8}>
            <Text style={styles.actionButtonText}>Mark Booked</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: COLORS.snoozed }]} onPress={() => setShowSnoozeSheet(true)} activeOpacity={0.8}>
            <Text style={styles.actionButtonText}>Snooze</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: COLORS.lostCancelled }]} onPress={() => setShowLostSheet(true)} activeOpacity={0.8}>
            <Text style={styles.actionButtonText}>Lost</Text>
          </TouchableOpacity>
        </View>
      )}

      {(canUnsnooze || canCancelFromSnooze) && (
        <View style={styles.actionBar}>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: COLORS.claimedBySales }]} onPress={handleUnsnooze} disabled={submitting} activeOpacity={0.8}>
            <Text style={styles.actionButtonText}>Unsnooze</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: COLORS.lostCancelled }]} onPress={() => setShowLostSheet(true)} activeOpacity={0.8}>
            <Text style={styles.actionButtonText}>Lost</Text>
          </TouchableOpacity>
        </View>
      )}

      <BottomSheet visible={showWonSheet} title="Mark as Booked" onClose={() => setShowWonSheet(false)}>
        <Text style={styles.sheetLabel}>Required Sets *</Text>
        <TextInput style={styles.sheetInput} placeholder={String(query.requiredSets || '')} placeholderTextColor={COLORS.textTertiary} value={requiredSetsInput} onChangeText={setRequiredSetsInput} keyboardType="numeric" autoFocus />
        <Text style={styles.sheetHelper}>{query.requiredSets ? `Pre-filled: ${query.requiredSets} sets` : '1 Set = 8 Pairs'}</Text>
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.wonPendingAccounts }]} onPress={handleMarkWon} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Booked</Text>}
        </TouchableOpacity>
      </BottomSheet>

      <BottomSheet visible={showSnoozeSheet} title="Snooze / Follow-up" onClose={() => setShowSnoozeSheet(false)}>
        <Text style={styles.sheetLabel}>Follow-up Date *</Text>
        <PlatformDatePicker
          value={followUpDate}
          minimumDate={new Date(Date.now() + 86400000)}
          onChange={setFollowUpDate}
        />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.snoozed }]} onPress={handleSnooze} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Snooze</Text>}
        </TouchableOpacity>
      </BottomSheet>

      <BottomSheet visible={showLostSheet} title="Mark as Lost / Cancelled" onClose={() => setShowLostSheet(false)}>
        <Text style={styles.sheetLabel}>Reason (optional)</Text>
        <TextInput style={[styles.sheetInput, { minHeight: 60 }]} placeholder="Reason (optional)" placeholderTextColor={COLORS.textTertiary} value={failureReason} onChangeText={setFailureReason} multiline />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.lostCancelled }]} onPress={() => setShowConfirmLost(true)} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Confirm Lost</Text>}
        </TouchableOpacity>
      </BottomSheet>

      <ConfirmDialog visible={showConfirmLost} title="Confirm Lost" message="Are you sure? This cannot be undone." confirmText="Yes, Mark Lost" onConfirm={handleMarkLost} onCancel={() => setShowConfirmLost(false)} destructive />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollView: { flex: 1 },
  content: { padding: 20, paddingBottom: 100 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  largeBadge: { paddingHorizontal: 14, paddingVertical: 6 },
  timeAgo: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  partyName: { fontSize: 24, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  detailsCard: { backgroundColor: COLORS.surface, borderRadius: 20, padding: 20, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  detailLabel: { fontSize: 13, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary, flex: 1 },
  detailValue: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, flex: 1, textAlign: 'right' },
  pairsHint: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginBottom: 8, textAlign: 'right' },
  notesText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, flex: 1, textAlign: 'right', lineHeight: 20 },
  separator: { height: 1, backgroundColor: COLORS.divider, marginVertical: 12 },
  timestamp: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, textAlign: 'right', marginBottom: 4 },
  sectionLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8 },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  itemName: { flex: 1, fontSize: 13, fontFamily: 'Inter_500Medium', color: COLORS.textPrimary, marginRight: 8 },
  itemDetail: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.primaryLight },
  snoozeInfo: { alignItems: 'center', paddingVertical: 8 },
  snoozeLabel: { fontSize: 13, fontFamily: 'Inter_500Medium', color: COLORS.snoozed, marginBottom: 4 },
  snoozeDate: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.snoozed },
  actionBar: { flexDirection: 'row', padding: 16, gap: 10, backgroundColor: COLORS.surface, borderTopWidth: 1, borderTopColor: COLORS.border },
  claimButton: { flex: 1, backgroundColor: COLORS.claimedBySales, borderRadius: 14, paddingVertical: 16, alignItems: 'center', shadowColor: COLORS.claimedBySales, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  claimButtonText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.white },
  actionButton: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  actionButtonText: { fontSize: 13, fontFamily: 'Inter_700Bold', color: COLORS.white },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border },
  sheetHelper: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 4, marginBottom: 16 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
