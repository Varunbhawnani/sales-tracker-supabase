import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  Keyboard,
} from 'react-native';
import { COLORS } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { createQuery } from '../services/queryService';
import { useGodownFilter } from '../contexts/GodownFilterContext';
import {
  getCachedCustomers,
  getCachedProducts,
  loadCustomersProgressive,
  loadProductsProgressive,
} from '../services/masterDataService';
import { sendNewQueryNotification } from '../services/notificationService';
import SearchableDropdown from '../components/SearchableDropdown';
import TierBadge from '../components/TierBadge';
import ProductSelector from '../components/ProductSelector';
import Toast from 'react-native-toast-message';

export default function NewQueryScreen({ navigation, route }) {
  const { userId, userName, userGodownId } = useAuth();
  const { godowns } = useGodownFilter();
  const prefilledCustomer = route?.params?.customer || null;
  // Active godowns the user can attach to this query. The list itself comes
  // from the godowns realtime subscription in GodownFilterContext so we
  // don't pay for our own listener here.
  const activeGodowns = (godowns || []).filter((g) => g.isActive);

  // Form state. Order on screen (top → bottom):
  //   1. Origin: Online / Offline (required)
  //   2. Customer (required)
  //   3. Notes (required — replaces the old "details" field)
  //   4. Products (OPTIONAL — just tags, no quantities or prices)
  // Cartoons + lots quantities are NOT entered here. They're set at Mark
  // Booked time by the salesperson/admin who closes the deal.
  const [origin, setOrigin] = useState(null);              // 'online' | 'offline'
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(prefilledCustomer);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  // Default the godown to the user's assigned one; can be overridden or
  // cleared to null (visible to all). Owners with no godown default to None.
  const [selectedGodownId, setSelectedGodownId] = useState(userGodownId || null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.headerBack}
        >
          <Text style={styles.headerBackArrow}>←</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cachedCustomers, cachedProducts] = await Promise.all([
        getCachedCustomers(),
        getCachedProducts(),
      ]);
      if (!cancelled) {
        if (cachedCustomers) setCustomers(cachedCustomers);
        if (cachedProducts) setProducts(cachedProducts);
        if (cachedCustomers || cachedProducts) setLoadingData(false);
      }

      if (!cancelled) setBackgroundLoading(true);
      try {
        await Promise.all([
          loadCustomersProgressive((batch) => {
            if (!cancelled) { setCustomers(batch); setLoadingData(false); }
          }),
          loadProductsProgressive((batch) => {
            if (!cancelled) setProducts(batch);
          }),
        ]);
      } catch (e) { /* cached fallback already shown */ }
      finally {
        if (!cancelled) { setLoadingData(false); setBackgroundLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async () => {
    if (!origin) {
      Alert.alert('Missing Field', 'Please select Online or Offline.'); return;
    }
    if (!selectedCustomer) {
      Alert.alert('Missing Field', 'Please select a customer.'); return;
    }
    if (!notes.trim()) {
      Alert.alert('Missing Field', 'Notes are required — describe what the customer wants.'); return;
    }
    // Products are optional. If present, validate that each has a product picked.
    for (let i = 0; i < items.length; i++) {
      if (!items[i].productId) {
        Alert.alert('Missing Field', `Please pick a product for Item ${i + 1}, or remove it.`); return;
      }
    }

    setSubmitting(true);
    try {
      // Strip out any quantity/price residue — these are entered at
      // Mark Booked time, not here.
      const cleanItems = items.map(item => ({
        productId: item.productId,
        productName: item.productName,
      }));

      const queryId = await createQuery({
        customerMasterId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        customerCategory: selectedCustomer.category || 'D',
        items: cleanItems,
        origin,
        notes: notes.trim(),
        userId,
        userName,
        godownId: selectedGodownId || null,
      });

      // Fire-and-forget the push notification (non-blocking).
      sendNewQueryNotification(selectedCustomer.name, 0, queryId, userId)
        .catch(err => console.warn('Push notification failed (non-fatal):', err?.message || err));

      Toast.show({
        type: 'success',
        text1: 'Query submitted',
        text2: `${selectedCustomer.name} (${origin})`,
        position: 'bottom',
      });

      Keyboard.dismiss();
      navigation.goBack();
    } catch (error) {
      console.error('Error creating query:', error);
      Alert.alert('Error', error?.message || 'Failed to submit query. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 80 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.screenTitle}>New Query</Text>
        <Text style={styles.screenSubtitle}>Record any customer enquiry — could be an order, a photo request, anything.</Text>

        {/* ─── 1. Origin: Online vs Offline ─── */}
        <View style={[styles.fieldGroup, { zIndex: 30 }]}>
          <Text style={styles.label}>Origin *</Text>
          <View style={styles.originRow}>
            <TouchableOpacity
              style={[styles.originBtn, origin === 'online' && styles.originBtnActive]}
              onPress={() => setOrigin('online')}
              activeOpacity={0.8}
            >
              <Text style={[styles.originText, origin === 'online' && styles.originTextActive]}>🌐 Online</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.originBtn, origin === 'offline' && styles.originBtnActive]}
              onPress={() => setOrigin('offline')}
              activeOpacity={0.8}
            >
              <Text style={[styles.originText, origin === 'offline' && styles.originTextActive]}>🏪 Offline</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ─── 2. Customer ─── */}
        <View style={[styles.fieldGroup, { zIndex: 20 }]}>
          <Text style={styles.label}>
            Customer *
            {backgroundLoading && customers.length > 0 && (
              <Text style={styles.loadingHint}>  (loading more… {customers.length})</Text>
            )}
          </Text>
          <SearchableDropdown
            data={customers}
            value={selectedCustomer}
            onSelect={setSelectedCustomer}
            placeholder={
              customers.length === 0 && loadingData
                ? 'Loading customers…' : 'Search customer...'
            }
            renderExtra={(item) => (
              <TierBadge category={item.category} style={{ marginLeft: 8 }} />
            )}
          />

          {selectedCustomer && (
            <View style={styles.selectedInfo}>
              <Text style={styles.selectedName}>{selectedCustomer.name}</Text>
              <TierBadge category={selectedCustomer.category} />
            </View>
          )}
        </View>

        {/* ─── Godown ─── */}
        {/* Optional. Picking a godown scopes who can see this query.
            Leaving it as "None" makes the query visible to everyone. */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Godown (optional)</Text>
          <View style={styles.godownRow}>
            <TouchableOpacity
              style={[styles.godownChip, !selectedGodownId && styles.godownChipActive]}
              onPress={() => setSelectedGodownId(null)}
            >
              <Text style={[styles.godownChipText, !selectedGodownId && styles.godownChipTextActive]}>
                None (visible to all)
              </Text>
            </TouchableOpacity>
            {activeGodowns.map((g) => (
              <TouchableOpacity
                key={g.id}
                style={[styles.godownChip, selectedGodownId === g.id && styles.godownChipActive]}
                onPress={() => setSelectedGodownId(g.id)}
              >
                <Text style={[styles.godownChipText, selectedGodownId === g.id && styles.godownChipTextActive]}>
                  {g.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {activeGodowns.length === 0 && (
            <Text style={styles.loadingHint}>
              No godowns created yet. The owner can add them in the Admin panel.
            </Text>
          )}
        </View>

        {/* ─── 3. Notes (required) ─── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Notes *</Text>
          <View style={[styles.inputContainer, styles.textAreaContainer]}>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Describe the customer's enquiry. E.g. wants photos of latest black formals, asking about bulk pricing on K401, etc."
              placeholderTextColor={COLORS.textTertiary}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />
          </View>
          <Text style={styles.helper}>Required — be specific so the team knows what's needed.</Text>
        </View>

        {/* ─── 4. Products (OPTIONAL) ─── */}
        <View style={[styles.fieldGroup, { zIndex: 10 }]}>
          <ProductSelector
            products={products}
            items={items}
            onItemsChange={setItems}
            optional
          />
        </View>

        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color={COLORS.white} />
          ) : (
            <Text style={styles.submitButtonText}>Submit Query</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20 },
  headerBack: { paddingHorizontal: 12, paddingVertical: 6 },
  headerBackArrow: { fontSize: 24, color: COLORS.primary, fontFamily: 'Inter_500Medium' },
  screenTitle: { fontSize: 24, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary, marginBottom: 4 },
  screenSubtitle: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 28, lineHeight: 18 },
  fieldGroup: { marginBottom: 22 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8, marginLeft: 4 },
  loadingHint: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  godownRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  godownChip: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  godownChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  godownChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  godownChipTextActive: { color: COLORS.white },
  helper: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 6, marginLeft: 4 },
  inputContainer: { backgroundColor: COLORS.surface, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 14 },
  input: { paddingVertical: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary },
  textAreaContainer: { minHeight: 120 },
  textArea: { minHeight: 100 },
  selectedInfo: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingHorizontal: 4 },
  selectedName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, flex: 1 },
  // Origin pill row
  originRow: { flexDirection: 'row', gap: 10 },
  originBtn: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 16,
    backgroundColor: COLORS.surface, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border, alignItems: 'center',
  },
  originBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  originText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  originTextActive: { color: COLORS.white },
  submitButton: {
    backgroundColor: COLORS.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8,
    shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  submitButtonDisabled: { opacity: 0.7 },
  submitButtonText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
