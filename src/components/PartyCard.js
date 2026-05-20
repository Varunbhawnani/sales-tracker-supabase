import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';
import { formatDateOnly } from '../utils/timeUtils';
import { formatSets } from '../utils/formatUtils';

const STATUS_INDICATORS = {
  active: { color: '#A3B087', label: 'Active' },
  gone_quiet: { color: '#A65D5D', label: 'Gone Quiet' },
  new: { color: '#8C9196', label: 'New' },
};

export default function PartyCard({ party, status, onPress }) {
  const indicator = STATUS_INDICATORS[status] || STATUS_INDICATORS.new;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onPress(party)}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <View style={styles.nameRow}>
          <View style={[styles.indicator, { backgroundColor: indicator.color }]} />
          <Text style={styles.name} numberOfLines={2}>{party.name}</Text>
        </View>
        <Text style={styles.statusLabel}>{indicator.label}</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatSets(party.totalSetsSold)}
          </Text>
          <Text style={styles.statLabel} numberOfLines={1}>Sets Sold</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
            {party.totalSuccessful || 0}
          </Text>
          <Text style={styles.statLabel} numberOfLines={1}>Orders</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
            {party.lastOrderDate ? formatDateOnly(party.lastOrderDate) : '—'}
          </Text>
          <Text style={styles.statLabel} numberOfLines={1}>Last Order</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 6,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  name: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textPrimary,
    flex: 1,
  },
  statusLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 12,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.primary,
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
  },
  divider: {
    width: 1,
    height: 30,
    backgroundColor: COLORS.border,
  },
});
