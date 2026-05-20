import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

export default function StatCard({ label, value, color, style }) {
  return (
    <View style={[styles.card, style]}>
      <Text style={[styles.value, color && { color }]}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 100,
    flex: 1,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  icon: {
    fontSize: 20,
    marginBottom: 4,
  },
  value: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    color: COLORS.primary,
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
});
