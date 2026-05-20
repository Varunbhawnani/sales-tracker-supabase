import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

export default function OfflineBanner({ visible }) {
  if (!visible) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>📡 You are offline — showing cached data</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: COLORS.warning,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.white,
  },
});
