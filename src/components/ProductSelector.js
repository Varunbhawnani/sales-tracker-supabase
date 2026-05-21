import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { COLORS } from '../utils/constants';
import SearchableDropdown from './SearchableDropdown';

/**
 * Multi-product selector for query creation.
 *
 * Products in a query are OPTIONAL and only carry { productId, productName }.
 * No quantity, no price — quantities (cartoons + lots) are entered at Mark
 * Booked time, not at query creation.
 *
 * Props:
 *   products: array of products from products_master
 *   items: [{ productId, productName }]
 *   onItemsChange: (updatedItems) => void
 *   optional: boolean — if true, shows "Products (optional)" instead of " *"
 */
export default function ProductSelector({
  products = [],
  items = [],
  onItemsChange,
  optional = false,
}) {

  const handleAddItem = () => {
    onItemsChange([...items, { productId: null, productName: '' }]);
  };

  const handleRemoveItem = (index) => {
    onItemsChange(items.filter((_, i) => i !== index));
  };

  const handleSelectProduct = (index, product) => {
    const updated = [...items];
    updated[index] = product
      ? { productId: product.id, productName: product.name }
      : { productId: null, productName: '' };
    onItemsChange(updated);
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>
          {optional ? 'Products (optional)' : 'Products *'}
        </Text>
        <TouchableOpacity style={styles.addBtn} onPress={handleAddItem}>
          <Text style={styles.addBtnText}>+ Add Item</Text>
        </TouchableOpacity>
      </View>

      {items.length === 0 && (
        <Text style={styles.emptyText}>
          {optional
            ? 'Skip this if the customer just wants photos / info, not specific items.'
            : 'Tap "+ Add Item" to add products.'}
        </Text>
      )}

      {items.map((item, index) => (
        <View key={index} style={styles.itemCard}>
          <View style={styles.itemHeader}>
            <Text style={styles.itemNumber}>Item {index + 1}</Text>
            <TouchableOpacity onPress={() => handleRemoveItem(index)}>
              <Text style={styles.removeText}>Remove</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.fieldLabel}>Product</Text>
          <SearchableDropdown
            data={products}
            value={item.productId ? { id: item.productId, name: item.productName } : null}
            onSelect={(product) => handleSelectProduct(index, product)}
            placeholder="Search product..."
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 8 },
  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12,
  },
  label: {
    fontSize: 13, fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSecondary, marginLeft: 4,
  },
  addBtn: {
    backgroundColor: COLORS.primary, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  addBtnText: {
    fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.white,
  },
  emptyText: {
    fontSize: 12, fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary, textAlign: 'center', paddingVertical: 16,
    backgroundColor: COLORS.surface, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border, borderStyle: 'dashed',
    paddingHorizontal: 16, lineHeight: 18,
  },
  itemCard: {
    backgroundColor: COLORS.surface, borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: COLORS.border,
  },
  itemHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10,
  },
  itemNumber: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
  removeText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.danger },
  fieldLabel: {
    fontSize: 12, fontFamily: 'Inter_500Medium',
    color: COLORS.textTertiary, marginBottom: 6, marginTop: 4, marginLeft: 2,
  },
});
