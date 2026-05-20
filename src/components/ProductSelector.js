import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { COLORS } from '../utils/constants';
import SearchableDropdown from './SearchableDropdown';

/**
 * Multi-product selector for query creation.
 *
 * The salesperson only picks product + quantity — pricing is NOT entered
 * manually. Behind the scenes we attach the Tally price (resolved via the
 * customer's price tier) so projected revenue still gets stored for the
 * owner / accounts views, but it's not surfaced to the salesperson here.
 *
 * Props:
 *   products: array of products from products_master
 *   items: [{ productId, productName, quantity, unitPrice, totalPrice }]
 *   onItemsChange: (updatedItems) => void
 *   customerPriceLevel: string (e.g., 'OS', 'OS1', 'FO') — picks price tier
 */
export default function ProductSelector({
  products = [],
  items = [],
  onItemsChange,
  customerPriceLevel,
}) {

  const getProductPrice = (product) => {
    if (!product) return 0;
    const level = (customerPriceLevel || '').toUpperCase();
    if (product.priceTiers && level && product.priceTiers[level]) {
      return product.priceTiers[level];
    }
    return product.price || 0;
  };

  const handleAddItem = () => {
    const newItem = {
      productId: null,
      productName: '',
      quantity: '',
      unitPrice: 0,
      totalPrice: 0,
    };
    onItemsChange([...items, newItem]);
  };

  const handleRemoveItem = (index) => {
    const updated = items.filter((_, i) => i !== index);
    onItemsChange(updated);
  };

  const handleSelectProduct = (index, product) => {
    const updated = [...items];
    if (product) {
      // Auto-pull the Tally price — not shown to the user, but stored for
      // downstream (owner dashboards, exports, etc.).
      const price = getProductPrice(product);
      updated[index] = {
        ...updated[index],
        productId: product.id,
        productName: product.name,
        unitPrice: price,
        totalPrice: price * (Number(updated[index].quantity) || 0),
      };
    } else {
      updated[index] = {
        ...updated[index],
        productId: null,
        productName: '',
        unitPrice: 0,
        totalPrice: 0,
      };
    }
    onItemsChange(updated);
  };

  const handleQuantityChange = (index, qtyText) => {
    const updated = [...items];
    const qty = qtyText.replace(/[^0-9]/g, '');
    updated[index] = {
      ...updated[index],
      quantity: qty,
      totalPrice: (Number(qty) || 0) * (updated[index].unitPrice || 0),
    };
    onItemsChange(updated);
  };

  const totalSets = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Products *</Text>
        <TouchableOpacity style={styles.addBtn} onPress={handleAddItem}>
          <Text style={styles.addBtnText}>+ Add Item</Text>
        </TouchableOpacity>
      </View>

      {items.length === 0 && (
        <Text style={styles.emptyText}>Tap "+ Add Item" to add products to this query.</Text>
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

          <Text style={styles.fieldLabel}>Qty (Sets)</Text>
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={item.quantity?.toString() || ''}
              onChangeText={(text) => handleQuantityChange(index, text)}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={COLORS.textTertiary}
            />
          </View>
          <Text style={styles.helper}>1 Set = 8 Pairs</Text>
        </View>
      ))}

      {items.length > 0 && (
        <View style={styles.totalsCard}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total Sets</Text>
            <Text style={styles.totalValue}>{totalSets}</Text>
          </View>
        </View>
      )}
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
    fontSize: 13, fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary, textAlign: 'center', paddingVertical: 20,
    backgroundColor: COLORS.surface, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border, borderStyle: 'dashed',
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
    color: COLORS.textTertiary, marginBottom: 6, marginTop: 8, marginLeft: 2,
  },
  inputContainer: {
    backgroundColor: COLORS.background, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 12,
  },
  input: {
    paddingVertical: 10, fontSize: 14, fontFamily: 'Inter_400Regular',
    color: COLORS.textPrimary,
  },
  helper: {
    fontSize: 11, fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary, marginTop: 4, marginLeft: 2,
  },
  totalsCard: {
    backgroundColor: COLORS.primary, borderRadius: 14, padding: 16, marginTop: 4,
  },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  totalLabel: {
    fontSize: 13, fontFamily: 'Inter_500Medium',
    color: COLORS.textInverse, opacity: 0.8,
  },
  totalValue: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: COLORS.textInverse,
  },
});
