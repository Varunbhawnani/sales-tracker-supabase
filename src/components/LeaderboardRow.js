import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';
import { formatSets, formatPercentage } from '../utils/formatUtils';



export default function LeaderboardRow({ item, isCurrentUser }) {
  const successRate = item.totalClaimed > 0
    ? formatPercentage(item.totalSuccessful, item.totalClaimed)
    : '0.0%';

  return (
    <View style={[styles.row, isCurrentUser && styles.highlighted]}>
      <View style={[styles.rankCircle, item.rank <= 3 && styles.rankTop3]}>
        <Text style={[styles.rankNumber, item.rank <= 3 && styles.rankTop3Text]}>{item.rank}</Text>
      </View>

      <View style={styles.info}>
        <Text style={[styles.name, isCurrentUser && styles.highlightedText]} numberOfLines={1}>
          {item.name}
          {isCurrentUser ? ' (You)' : ''}
        </Text>
        <View style={styles.statsRow}>
          <Text style={styles.stat}>
            <Text style={styles.statValue}>{formatSets(item.totalSetsSold)}</Text> Sets
          </Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.stat}>
            <Text style={styles.statValue}>{item.totalSuccessful || 0}</Text> Won
          </Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.stat}>{successRate}</Text>
        </View>
      </View>

      <View style={styles.setsContainer}>
        <Text style={[styles.setsValue, isCurrentUser && styles.highlightedText]}>
          {formatSets(item.totalSetsSold)}
        </Text>
        <Text style={styles.setsLabel}>Sets</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 4,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  highlighted: {
    backgroundColor: '#E2E8EC',
    borderWidth: 1.5,
    borderColor: COLORS.primary,
  },
  rankCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.divider,
  },
  rankTop3: {
    backgroundColor: COLORS.primary,
  },
  rankNumber: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textSecondary,
  },
  rankTop3Text: {
    color: COLORS.white,
  },
  info: {
    flex: 1,
    marginLeft: 8,
  },
  name: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  highlightedText: {
    color: COLORS.primary,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stat: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSecondary,
  },
  statValue: {
    fontFamily: 'Inter_600SemiBold',
  },
  dot: {
    fontSize: 12,
    color: COLORS.textTertiary,
    marginHorizontal: 6,
  },
  setsContainer: {
    alignItems: 'center',
    marginLeft: 12,
  },
  setsValue: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: COLORS.primary,
  },
  setsLabel: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
  },
});
