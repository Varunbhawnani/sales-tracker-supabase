import React from 'react';
import { View } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Web date picker. Renders a styled <input type="date"> directly — the
 * browser handles all the picker UI natively, so no button/modal needed.
 *
 * Props match PlatformDatePicker.native.js so callers can `import
 * PlatformDatePicker from '../components/PlatformDatePicker'` and the
 * right implementation is picked automatically by the bundler.
 */
const toIsoDate = (d) => {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default function PlatformDatePicker({ value, minimumDate, onChange }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <input
        type="date"
        value={toIsoDate(value)}
        min={toIsoDate(minimumDate)}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const [y, m, d] = v.split('-').map(Number);
          onChange(new Date(y, m - 1, d));
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          backgroundColor: COLORS.background,
          borderRadius: 12,
          padding: 14,
          fontSize: 15,
          fontFamily: 'Inter_600SemiBold, system-ui, sans-serif',
          color: COLORS.primary,
          border: `1px solid ${COLORS.border}`,
          cursor: 'pointer',
          outline: 'none',
        }}
      />
    </View>
  );
}
