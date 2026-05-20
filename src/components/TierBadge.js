import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Simple text-based category tier badge (A, B, C, D).
 * Uses the existing color scheme — no special colors per tier.
 */
export default function TierBadge({ category, style }) {
  const tier = (category || 'D').toString().trim().toUpperCase();

  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.text}>{tier}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textInverse,
    letterSpacing: 0.5,
  },
});
