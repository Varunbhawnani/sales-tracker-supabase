import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { COLORS, ROLES, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToResponsibilities } from '../services/responsibilitiesService';
import EmptyState from '../components/EmptyState';
import LoadingState from '../components/LoadingState';

const ROLE_TITLES = {
  [ROLES.OWNER]: 'Owner',
  [ROLES.SALESPERSON]: 'Sales',
  [ROLES.ACCOUNTS]: 'Accounts',
  [ROLES.PACKING]: 'Packing',
  [ROLES.DISPATCH]: 'Dispatch',
  [ROLES.OPERATIONS]: 'Operations',
};

/**
 * Read-only viewer for the user's own role responsibilities. The owner edits
 * these via the Admin screen; everyone else just sees them as guidance.
 *
 * Reachable from each role's main dashboard header via a small "📋 My Role"
 * button (wired up in subsequent edits). Owner can also pull it up for any
 * other role to preview what they see.
 */
export default function ResponsibilitiesScreen({ route, navigation }) {
  const { userRole } = useAuth();
  // Allow override via navigation param (owner previewing another role).
  const targetRole = route?.params?.role || userRole;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const unsub = subscribeToResponsibilities((list) => {
      setItems(list);
      setLoading(false);
      setRefreshing(false);
    }, { role: targetRole });
    return () => unsub();
  }, [targetRole]);

  if (loading) return <LoadingState />;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation?.goBack?.()} style={styles.backBtn}>
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>My Responsibilities</Text>
          <Text style={styles.headerSubtitle}>
            {ROLE_TITLES[targetRole] || targetRole} role
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); /* sub will refresh via realtime + AppState */ setTimeout(() => setRefreshing(false), 800); }}
            colors={[COLORS.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {items.length === 0 ? (
          <EmptyState
            title="No responsibilities set"
            message="The admin hasn't added responsibilities for your role yet. Check back later or ask the admin to add them."
          />
        ) : (
          items.map((r, i) => (
            <View key={r.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardIndex}>{i + 1}</Text>
                <Text style={styles.cardTitle}>{r.title}</Text>
              </View>
              {r.steps.length === 0 ? (
                <Text style={styles.emptyStep}>No steps listed for this responsibility yet.</Text>
              ) : (
                r.steps.map((s, idx) => (
                  <View key={idx} style={styles.stepRow}>
                    <View style={styles.stepBullet}>
                      <Text style={styles.stepBulletText}>{idx + 1}</Text>
                    </View>
                    <Text style={styles.stepText}>{s}</Text>
                  </View>
                ))
              )}
            </View>
          ))
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingTop: SAFE_TOP + 8, paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    gap: 8,
  },
  backBtn: { paddingHorizontal: 6, paddingVertical: 6 },
  backIcon: { fontSize: 22, color: COLORS.primary, fontFamily: 'Inter_500Medium' },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardIndex: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: COLORS.primary, color: COLORS.white,
    textAlign: 'center', lineHeight: 28,
    fontFamily: 'Inter_700Bold', fontSize: 13,
    marginRight: 10, overflow: 'hidden',
  },
  cardTitle: {
    flex: 1, fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary,
  },
  stepRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: 6,
  },
  stepBullet: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: COLORS.background,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 10, marginTop: 2,
  },
  stepBulletText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  stepText: {
    flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular',
    color: COLORS.textPrimary, lineHeight: 20,
  },
  emptyStep: {
    fontSize: 12, fontFamily: 'Inter_400Regular',
    color: COLORS.textTertiary, paddingVertical: 6,
  },
});
