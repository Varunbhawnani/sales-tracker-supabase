import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

export default function EmptyState({ title, message, style }) {
  return (
    <View style={[styles.container, style]}>
      <View style={styles.iconCircle}>
        <Text style={styles.dash}>—</Text>
      </View>
      <Text style={styles.title}>{title || 'Nothing here yet'}</Text>
      {message && <Text style={styles.message}>{message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  dash: {
    fontSize: 20,
    color: COLORS.textTertiary,
    fontFamily: 'Inter_700Bold',
  },
  title: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
