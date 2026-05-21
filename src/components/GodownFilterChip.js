import React, { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, ScrollView, Platform,
} from 'react-native';
import { COLORS } from '../utils/constants';
import {
  useGodownFilter, FILTER_ALL, FILTER_UNASSIGNED,
} from '../contexts/GodownFilterContext';

/**
 * Compact pill that surfaces the current godown filter and opens a picker
 * sheet when tapped. Renders nothing for non-owner roles.
 *
 * Sits in the WebShell top bar on desktop and in each owner screen header on
 * native, so the owner can switch godowns from anywhere without bouncing back
 * to the Admin tab.
 */
export default function GodownFilterChip({ compact = false, style }) {
  const { isOwner, filterId, setFilterId, godowns } = useGodownFilter();
  const [open, setOpen] = useState(false);

  const activeGodowns = useMemo(() => godowns.filter((g) => g.isActive), [godowns]);

  if (!isOwner) return null;

  const currentLabel = (() => {
    if (filterId === FILTER_ALL) return 'All Godowns';
    if (filterId === FILTER_UNASSIGNED) return 'Unassigned';
    return godowns.find((g) => g.id === filterId)?.name || 'All Godowns';
  })();

  const pick = (id) => {
    setFilterId(id);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.chip, compact && styles.chipCompact, style]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.chipIcon}>🏬</Text>
        <Text style={[styles.chipLabel, compact && styles.chipLabelCompact]} numberOfLines={1}>
          {currentLabel}
        </Text>
        <Text style={styles.caret}>▾</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={styles.sheet}
            onPress={(e) => { e.stopPropagation?.(); }}
          >
            <Text style={styles.sheetTitle}>View as godown</Text>
            <Text style={styles.sheetSub}>
              Pick a godown to scope the whole app to that godown's users. Pick "All Godowns" to see everything.
            </Text>

            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              <PickerRow
                label="All Godowns"
                selected={filterId === FILTER_ALL}
                onPress={() => pick(FILTER_ALL)}
              />
              <PickerRow
                label="Unassigned"
                selected={filterId === FILTER_UNASSIGNED}
                onPress={() => pick(FILTER_UNASSIGNED)}
              />
              {activeGodowns.map((g) => (
                <PickerRow
                  key={g.id}
                  label={g.name}
                  selected={filterId === g.id}
                  onPress={() => pick(g.id)}
                />
              ))}
              {activeGodowns.length === 0 && (
                <Text style={styles.emptyHint}>
                  No godowns yet — add one in the Admin tab.
                </Text>
              )}
            </ScrollView>

            <TouchableOpacity style={styles.closeBtn} onPress={() => setOpen(false)}>
              <Text style={styles.closeBtnText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function PickerRow({ label, selected, onPress }) {
  return (
    <TouchableOpacity style={[styles.row, selected && styles.rowActive]} onPress={onPress}>
      <Text style={[styles.rowText, selected && styles.rowTextActive]}>{label}</Text>
      {selected && <Text style={styles.tick}>✓</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 220,
  },
  chipCompact: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    maxWidth: 180,
  },
  chipIcon: { fontSize: 13, marginRight: 6 },
  chipLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.primary,
    flexShrink: 1,
  },
  chipLabelCompact: { fontSize: 12 },
  caret: {
    fontSize: 11,
    color: COLORS.primary,
    marginLeft: 6,
  },
  backdrop: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    padding: 20,
    ...(Platform.OS === 'web' ? { cursor: 'auto' } : {}),
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  sheetSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSecondary,
    marginBottom: 12,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
  },
  rowActive: {},
  rowText: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textPrimary,
  },
  rowTextActive: { color: COLORS.primary, fontFamily: 'Inter_700Bold' },
  tick: { fontSize: 16, color: COLORS.primary, fontFamily: 'Inter_700Bold' },
  emptyHint: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
    paddingVertical: 14,
    textAlign: 'center',
  },
  closeBtn: {
    marginTop: 12,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  closeBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSecondary,
  },
});
