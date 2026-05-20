import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

export default function LoadingState({ style, timeout = 8000 }) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), timeout);
    return () => clearTimeout(timer);
  }, [timeout]);

  return (
    <View style={[styles.container, style]}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      {timedOut && (
        <Text style={styles.hint}>
          Taking longer than expected...{'\n'}Pull down to refresh or check your connection.
        </Text>
      )}
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
  hint: {
    marginTop: 16,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
    textAlign: 'center',
    lineHeight: 18,
  },
});
