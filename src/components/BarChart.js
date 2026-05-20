import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Simple horizontal bar chart built with pure Views (no chart library needed).
 */
export default function BarChart({ data, title, barColor, maxValue: propMaxValue }) {
  if (!data || data.length === 0) {
    return (
      <View style={styles.container}>
        {title && <Text style={styles.title}>{title}</Text>}
        <Text style={styles.empty}>No data available</Text>
      </View>
    );
  }

  const maxValue = propMaxValue || Math.max(...data.map(d => d.value), 1);

  return (
    <View style={styles.container}>
      {title && <Text style={styles.title}>{title}</Text>}
      {data.map((item, index) => (
        <View key={index} style={styles.row}>
          <Text style={styles.label} numberOfLines={1}>{item.label}</Text>
          <View style={styles.barContainer}>
            <View
              style={[
                styles.bar,
                {
                  width: `${Math.max((item.value / maxValue) * 100, 2)}%`,
                  backgroundColor: item.color || barColor || COLORS.primary,
                },
              ]}
            />
          </View>
          <Text style={styles.value}>{item.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 8,
  },
  title: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textPrimary,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  label: {
    width: 80,
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
  },
  barContainer: {
    flex: 1,
    height: 22,
    backgroundColor: COLORS.divider,
    borderRadius: 6,
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 6,
  },
  value: {
    width: 40,
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textPrimary,
    textAlign: 'right',
  },
  empty: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
