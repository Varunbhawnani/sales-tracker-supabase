import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS, STATUS } from '../utils/constants';
import StatusBadge from './StatusBadge';
import TierBadge from './TierBadge';
import { relativeTime } from '../utils/timeUtils';
import { formatQuantity } from '../utils/formatUtils';

function QueryCard({ query, onPress }) {
  const displayName = query.customerName || query.partyName || 'Unknown';
  const displayQty = query.requiredSets || query.quantityRequested || 0;
  const isSnoozed = query.status === STATUS.SNOOZED;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onPress(query)}
      activeOpacity={0.7}
    >
      <View style={styles.topRow}>
        <StatusBadge status={query.status} />
        <Text style={styles.timeAgo}>{relativeTime(query.createdAt)}</Text>
      </View>

      <View style={styles.mainRow}>
        <View style={styles.nameRow}>
          <Text style={styles.partyName} numberOfLines={1}>{displayName}</Text>
          {query.customerCategory && (
            <TierBadge category={query.customerCategory} style={{ marginLeft: 6 }} />
          )}
        </View>
        <Text style={styles.quantity}>{formatQuantity(displayQty)}</Text>
      </View>

      {/* Projected Revenue */}
      {query.projectedRevenue > 0 && (
        <Text style={styles.revenue}>
          ₹{query.projectedRevenue.toLocaleString('en-IN')}
        </Text>
      )}

      {/* Snooze indicator */}
      {isSnoozed && query.followUpDate && (
        <View style={styles.snoozeRow}>
          <Text style={styles.snoozeIcon}>⏰</Text>
          <Text style={styles.snoozeText}>
            Follow-up: {query.followUpDate instanceof Date
              ? query.followUpDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
              : 'Scheduled'}
          </Text>
        </View>
      )}

      {/* Notes snippet */}
      {query.notes ? (
        <Text style={styles.notes} numberOfLines={1}>{query.notes}</Text>
      ) : null}

      {/* Items summary */}
      {query.items && query.items.length > 0 && (
        <Text style={styles.itemsSummary} numberOfLines={1}>
          {query.items.length} item{query.items.length > 1 ? 's' : ''}: {query.items.map(i => i.productName).filter(Boolean).join(', ')}
        </Text>
      )}

      {/* Claimed by */}
      {query.claimedBy && (
        <Text style={styles.claimedBy}>
          {query.status === STATUS.OPEN_QUERY ? '' : `Claimed by ${query.claimedBy.name}`}
        </Text>
      )}

      {/* Dispatch progress */}
      {(query.status === STATUS.PARTIALLY_DISPATCHED || query.status === STATUS.COMPLETED) && (
        <Text style={styles.dispatchInfo}>
          Dispatched: {query.dispatchedSets || 0} / {query.requiredSets || 0} sets
        </Text>
      )}
    </TouchableOpacity>
  );
}

export default memo(QueryCard);

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    marginHorizontal: 16,
    marginVertical: 5,
    borderRadius: 16,
    padding: 16,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  timeAgo: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
  },
  mainRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  partyName: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  quantity: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.primary,
  },
  revenue: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.primaryLight,
    marginBottom: 4,
  },
  snoozeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    backgroundColor: COLORS.snoozedBg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  snoozeIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  snoozeText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: COLORS.snoozed,
  },
  notes: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSecondary,
    marginTop: 6,
  },
  itemsSummary: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
    marginTop: 4,
  },
  claimedBy: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textTertiary,
    marginTop: 6,
  },
  dispatchInfo: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.primaryLight,
    marginTop: 4,
  },
});
