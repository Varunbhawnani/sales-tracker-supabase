import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Visual progress bar showing dispatch fulfillment.
 * Props:
 *   dispatched: number of sets dispatched
 *   required: total required sets
 *   showLabel: whether to show text label (default true)
 */
export default function FulfillmentBar({ dispatched = 0, required = 0, showLabel = true }) {
  const pct = required > 0 ? Math.min((dispatched / required) * 100, 100) : 0;
  const isComplete = pct >= 100;

  const barColor = isComplete
    ? COLORS.completed
    : pct >= 50
      ? COLORS.wonPendingAccounts
      : COLORS.primaryLight;

  return (
    <View style={styles.container}>
      {showLabel && (
        <View style={styles.labelRow}>
          <Text style={styles.label}>
            {dispatched} / {required} sets
          </Text>
          <Text style={[styles.pctText, { color: barColor }]}>
            {Math.round(pct)}%
          </Text>
        </View>
      )}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: barColor }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 6,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
  },
  pctText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  track: {
    height: 8,
    backgroundColor: COLORS.divider,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
});
