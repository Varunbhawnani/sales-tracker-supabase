import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * A donut-style ring chart built with pure Views.
 * Shows a percentage with a colored ring arc.
 */
export default function RingChart({ value, total, label, color, size = 100 }) {
  const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
  const ringWidth = 10;
  const innerSize = size - ringWidth * 2;

  return (
    <View style={styles.container}>
      <View style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderColor: COLORS.divider }]}>
        {/* Colored progress overlay */}
        <View
          style={[
            styles.ring,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: color || COLORS.primary,
              borderWidth: ringWidth,
              position: 'absolute',
              opacity: 0.2,
            },
          ]}
        />
        {/* Inner content */}
        <View style={[styles.inner, { width: innerSize, height: innerSize, borderRadius: innerSize / 2 }]}>
          <Text style={[styles.percentText, { color: color || COLORS.primary }]}>{percentage}%</Text>
        </View>
      </View>
      {label && <Text style={styles.label}>{label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  ring: {
    borderWidth: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  percentText: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
    marginTop: 8,
    textAlign: 'center',
  },
});
