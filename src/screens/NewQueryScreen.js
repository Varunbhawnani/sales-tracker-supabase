import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  Keyboard,
} from 'react-native';
import { COLORS } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { createQuery } from '../services/queryService';
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

const FALLBACK_KEYBOARD_HEIGHT = 340;

export default function NewQueryScreen({ navigation, route }) {
  const { userId, userName } = useAuth();
  const prefilledCustomer = route?.params?.customer || null;

  const scrollViewRef = useRef(null);

  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(prefilledCustomer);
  const [items, setItems] = useState([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

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
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height || FALLBACK_KEYBOARD_HEIGHT);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

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
      } catch (e) {
        // network failure → cache fallback
      } finally {
        if (!cancelled) {
          setLoadingData(false);
          setBackgroundLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const totalSets = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const totalRevenue = items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);

  // Wait for the keyboard to start animating in, then scroll the Notes field
  // (which is the last element on the page) into view. KeyboardAvoidingView
  // does the heavy lifting; we just need to nudge the ScrollView to the
  // bottom so the input doesn't sit under the keyboard.
  const handleNotesFocus = () => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 250);
  };

  const handleSubmit = async () => {
    if (!selectedCustomer) { Alert.alert('Missing Field', 'Please select a customer.'); return; }
    if (items.length === 0) { Alert.alert('Missing Field', 'Please add at least one product.'); return; }
    for (let i = 0; i < items.length; i++) {
      if (!items[i].productId) { Alert.alert('Missing Field', `Please select a product for Item ${i + 1}.`); return; }
      if (!items[i].quantity || Number(items[i].quantity) <= 0) {
        Alert.alert('Missing Field', `Please enter a valid quantity for Item ${i + 1}.`); return;
      }
    }

    setSubmitting(true);
    try {
      const cleanItems = items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        quantity: Number(item.quantity),
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      }));

      const queryId = await createQuery({
        customerMasterId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        customerCategory: selectedCustomer.category || 'D',
        items: cleanItems,
        requiredSets: totalSets,
        projectedRevenue: totalRevenue,
        notes: notes.trim(),
        userId,
        userName,
      });

      // Fire-and-forget the push notification — don't block the UI on a
      // slow / failing call to Expo's push API. If the notification fails
      // the user has already created the query successfully.
      sendNewQueryNotification(
        selectedCustomer.name, totalSets, queryId, userId,
      ).catch(err => console.warn('Push notification failed (non-fatal):', err?.message || err));

      Toast.show({
        type: 'success',
        text1: 'Query submitted',
        text2: `${selectedCustomer.name} — ${totalSets} Sets`,
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

  const dynamicPaddingBottom = keyboardHeight > 0 ? keyboardHeight + 240 : 40;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={[styles.content, { paddingBottom: dynamicPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.screenTitle}>New Query</Text>
        <Text style={styles.screenSubtitle}>Enter a customer query to track</Text>

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
              {selectedCustomer.priceLevel && (
                <Text style={styles.priceLevelText}>
                  Price: {selectedCustomer.priceLevel}
                </Text>
              )}
            </View>
          )}
        </View>

        <View style={[styles.fieldGroup, { zIndex: 10 }]}>
          <ProductSelector
            products={products}
            items={items}
            onItemsChange={setItems}
            customerPriceLevel={selectedCustomer?.priceLevel}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Notes (Optional)</Text>
          <View style={[styles.inputContainer, styles.textAreaContainer]}>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Any additional details..."
              placeholderTextColor={COLORS.textTertiary}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              onFocus={handleNotesFocus}
            />
          </View>
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
  screenSubtitle: { fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 28 },
  fieldGroup: { marginBottom: 22 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8, marginLeft: 4 },
  loadingHint: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  inputContainer: { backgroundColor: COLORS.surface, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 14 },
  input: { paddingVertical: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary },
  textAreaContainer: { minHeight: 100 },
  textArea: { minHeight: 80 },
  selectedInfo: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingHorizontal: 4 },
  selectedName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.primary, flex: 1 },
  priceLevelText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary },
  submitButton: {
    backgroundColor: COLORS.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8,
    shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  submitButtonDisabled: { opacity: 0.7 },
  submitButtonText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
