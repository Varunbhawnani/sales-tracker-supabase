import React, { useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Platform, TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Native (iOS / Android) date picker. Shows a button with the current date;
 * tapping opens the platform-native spinner / wheel.
 *
 * Props:
 *   value:        Date    — currently selected date
 *   minimumDate:  Date    — earliest allowed selection
 *   onChange:    (Date)=> — called when the user picks a new date
 */
export default function PlatformDatePicker({ value, minimumDate, onChange }) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <View>
      <TouchableOpacity
        style={styles.button}
        onPress={() => setShowPicker(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.buttonText}>
          {value.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </Text>
      </TouchableOpacity>
      {showPicker && (
        <DateTimePicker
          value={value}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          minimumDate={minimumDate}
          onChange={(_event, date) => {
            // iOS spinner stays open until user dismisses; Android closes after pick.
            setShowPicker(Platform.OS === 'ios');
            if (date) onChange(date);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 16,
  },
  buttonText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.primary,
  },
});
