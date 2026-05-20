import React, { useState } from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../utils/constants';
import Toast from 'react-native-toast-message';

export default function ExportButton({ onExport, label = 'Export', style }) {
  const [loading, setLoading] = useState(false);

  const handlePress = async () => {
    setLoading(true);
    try {
      await onExport();
    } catch (error) {
      const message = error.message || 'Export failed.';
      Toast.show({
        type: 'error',
        text1: message === 'No data to export.' ? message : 'Export Failed',
        text2: message === 'No data to export.' ? '' : message,
        position: 'bottom',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <TouchableOpacity
      style={[styles.button, style]}
      onPress={handlePress}
      disabled={loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <>
          <ActivityIndicator size="small" color={COLORS.primary} />
          <Text style={styles.loadingText}>Exporting...</Text>
        </>
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.primary,
  },
  loadingText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSecondary,
  },
});
