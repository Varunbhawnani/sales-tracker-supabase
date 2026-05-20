import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Keyboard,
} from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * Reusable searchable dropdown fed from a data array.
 * Props:
 *   data: [{ id, name, ...extra }]
 *   value: currently selected item (object or null)
 *   onSelect: (item) => void
 *   placeholder: string
 *   renderExtra: (item) => ReactNode (optional, renders beside name in list)
 *   disabled: boolean
 */
export default function SearchableDropdown({
  data = [],
  value,
  onSelect,
  placeholder = 'Search...',
  renderExtra,
  disabled = false,
}) {
  const [searchText, setSearchText] = useState(value?.name || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef(null);

  const filtered = data.filter(item =>
    item.name?.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleSelect = (item) => {
    setSearchText(item.name);
    setShowDropdown(false);
    Keyboard.dismiss();
    onSelect(item);
  };

  const handleChangeText = (text) => {
    setSearchText(text);
    setShowDropdown(true);
    if (!text) onSelect(null);
  };

  const handleFocus = () => {
    setShowDropdown(true);
  };

  const handleBlur = () => {
    // Delay to allow tap on dropdown item
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.inputContainer, disabled && styles.inputDisabled]}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textTertiary}
          value={searchText}
          onChangeText={handleChangeText}
          onFocus={handleFocus}
          onBlur={handleBlur}
          editable={!disabled}
        />
        {searchText.length > 0 && !disabled && (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={() => {
              setSearchText('');
              onSelect(null);
              inputRef.current?.focus();
            }}
          >
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {showDropdown && searchText.length > 0 && (
        <View style={styles.dropdown}>
          {filtered.length > 0 ? (
            // Capped at 8 visible matches — render as plain Views (no FlatList) so
            // the dropdown can live inside a parent ScrollView without warnings
            // about nested VirtualizedLists.
            filtered.slice(0, 8).map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.dropdownItem}
                onPress={() => handleSelect(item)}
                activeOpacity={0.7}
              >
                <Text style={styles.dropdownText} numberOfLines={1}>
                  {item.name}
                </Text>
                {renderExtra && renderExtra(item)}
              </TouchableOpacity>
            ))
          ) : (
            <Text style={styles.noResults}>No results found</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 10,
  },
  inputContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputDisabled: {
    opacity: 0.6,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textPrimary,
  },
  clearBtn: {
    padding: 4,
    marginLeft: 4,
  },
  clearText: {
    fontSize: 14,
    color: COLORS.textTertiary,
    fontFamily: 'Inter_500Medium',
  },
  dropdown: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 4,
    maxHeight: 280,
    overflow: 'hidden',
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  dropdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
  },
  dropdownText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textPrimary,
  },
  noResults: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary,
    textAlign: 'center',
  },
});
