import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { COLORS, ROLES, SAFE_TOP } from '../utils/constants';
import { getAllUsers, createUser, deactivateUser, reactivateUser } from '../services/authService';
import { getSettings, updateSettings } from '../services/settingsService';
import { getAllQueriesOnce } from '../services/queryService';
import { getLeaderboardData } from '../services/statsService';
import { getAllCustomers } from '../services/masterDataService';
import { exportAll } from '../services/exportService';
import ConfirmDialog from '../components/ConfirmDialog';
import ExportButton from '../components/ExportButton';
import LoadingState from '../components/LoadingState';
import Toast from 'react-native-toast-message';

const ROLE_OPTIONS = [
  { key: ROLES.SALESPERSON, label: 'Sales' },
  { key: ROLES.ACCOUNTS, label: 'Accounts' },
  { key: ROLES.PACKING, label: 'Packing' },
  { key: ROLES.DISPATCH, label: 'Dispatch' },
];

const ROLE_LABELS = {
  [ROLES.OWNER]: 'Owner',
  [ROLES.SALESPERSON]: 'Sales',
  [ROLES.ACCOUNTS]: 'Accounts',
  [ROLES.PACKING]: 'Packing',
  [ROLES.DISPATCH]: 'Dispatch',
};

export default function AdminScreen() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettingsState] = useState({});

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState(ROLES.SALESPERSON);
  const [creating, setCreating] = useState(false);

  const [thresholdInput, setThresholdInput] = useState('30');
  const [slaEscInput, setSlaEscInput] = useState('10');
  const [slaAccInput, setSlaAccInput] = useState('3');
  const [slaDispInput, setSlaDispInput] = useState('7');
  const [savingSettings, setSavingSettings] = useState(false);

  const [actionTarget, setActionTarget] = useState(null);
  const [actionType, setActionType] = useState(null);

  const [exporting, setExporting] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [u, s] = await Promise.all([getAllUsers(), getSettings()]);
      setUsers(u);
      setSettingsState(s);
      setThresholdInput(String(s.gonequietThresholdDays || 30));
      setSlaEscInput(String(s.slaEscalationDays || 10));
      setSlaAccInput(String(s.slaAccountsDays || 3));
      setSlaDispInput(String(s.slaDispatchDays || 7));
    } catch (error) {
      console.error('Error loading admin data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async () => {
    if (!newName.trim() || !newUsername.trim() || !newPassword.trim()) {
      Alert.alert('Required', 'Please fill in all fields.');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Invalid', 'Password must be at least 6 characters.');
      return;
    }
    setCreating(true);
    try {
      await createUser(newName.trim(), newUsername.trim().toLowerCase(), newPassword, newRole);
      Toast.show({
        type: 'success',
        text1: 'User created',
        text2: `${newName.trim()} (${ROLE_LABELS[newRole]}) can now log in.`,
        position: 'bottom',
      });
      setShowAddForm(false);
      setNewName('');
      setNewUsername('');
      setNewPassword('');
      setNewRole(ROLES.SALESPERSON);
      loadData();
    } catch (error) {
      const msg = error.message?.includes('already registered') || error.message?.includes('already in use')
        ? 'This username is already taken.'
        : error.message;
      Alert.alert('Error', msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDeactivate = async () => {
    if (!actionTarget) return;
    try {
      await deactivateUser(actionTarget.id);
      Toast.show({ type: 'success', text1: 'Account deactivated', position: 'bottom' });
      setActionTarget(null);
      setActionType(null);
      loadData();
    } catch (error) {
      Alert.alert('Error', 'Failed to deactivate account.');
    }
  };

  const handleReactivate = async (user) => {
    try {
      await reactivateUser(user.id);
      Toast.show({ type: 'success', text1: `${user.name} reactivated`, position: 'bottom' });
      loadData();
    } catch (error) {
      Alert.alert('Error', 'Failed to reactivate.');
    }
  };

  const showActionMenu = (u) => {
    Alert.alert(u.name, `Role: ${ROLE_LABELS[u.role] || u.role}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: u.isActive === false ? 'Reactivate' : 'Deactivate',
        style: u.isActive === false ? 'default' : 'destructive',
        onPress: () => {
          if (u.isActive === false) {
            handleReactivate(u);
          } else {
            setActionTarget(u);
            setActionType('deactivate');
          }
        },
      },
    ]);
  };

  const handleSaveSettings = async () => {
    const gq = parseInt(thresholdInput);
    const esc = parseInt(slaEscInput);
    const acc = parseInt(slaAccInput);
    const disp = parseInt(slaDispInput);
    if ([gq, esc, acc, disp].some(v => isNaN(v) || v < 1)) {
      Alert.alert('Invalid', 'All fields must be positive numbers.');
      return;
    }
    setSavingSettings(true);
    try {
      await updateSettings({
        gonequietThresholdDays: gq,
        slaEscalationDays: esc,
        slaAccountsDays: acc,
        slaDispatchDays: disp,
      });
      Toast.show({ type: 'success', text1: 'Settings saved', position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleMasterExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const [allQueries, leaderboard, customers] = await Promise.all([
        getAllQueriesOnce(),
        getLeaderboardData(),
        getAllCustomers(),
      ]);
      await exportAll(allQueries, customers, leaderboard, settings.gonequietThresholdDays || 30);
    } catch (e) {
      Alert.alert('Export failed', e?.message || 'Could not generate the export.');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <LoadingState />;

  const activeUsers = users.filter(u => u.isActive !== false && u.role !== ROLES.OWNER);
  const inactiveUsers = users.filter(u => u.isActive === false);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Text style={styles.pageTitle}>Admin Panel</Text>
      <Text style={styles.pageSubtitle}>Manage users, SLA thresholds & settings</Text>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Manage Users</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowAddForm(!showAddForm)}>
            <Text style={styles.addBtnText}>{showAddForm ? 'Close' : '+ Add User'}</Text>
          </TouchableOpacity>
        </View>

        {showAddForm && (
          <View style={styles.addForm}>
            <TextInput style={styles.formInput} placeholder="Full Name" placeholderTextColor={COLORS.textTertiary} value={newName} onChangeText={setNewName} />
            <TextInput style={styles.formInput} placeholder="Username (e.g., rahul)" placeholderTextColor={COLORS.textTertiary} value={newUsername} onChangeText={setNewUsername} autoCapitalize="none" />
            <TextInput style={styles.formInput} placeholder="Password (min 6 chars)" placeholderTextColor={COLORS.textTertiary} value={newPassword} onChangeText={setNewPassword} secureTextEntry />
            <Text style={styles.roleLabel}>Role</Text>
            <View style={styles.rolePicker}>
              {ROLE_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.roleOption, newRole === opt.key && styles.roleOptionActive]}
                  onPress={() => setNewRole(opt.key)}
                >
                  <Text style={[styles.roleOptionText, newRole === opt.key && styles.roleOptionTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={[styles.createBtn, creating && { opacity: 0.7 }]} onPress={handleCreateUser} disabled={creating}>
              {creating ? <ActivityIndicator color={COLORS.white} size="small" /> : <Text style={styles.createBtnText}>Create Account</Text>}
            </TouchableOpacity>
          </View>
        )}

        {activeUsers.length === 0 ? (
          <Text style={styles.emptyText}>No active users. Tap + Add User to create one.</Text>
        ) : (
          activeUsers.map(u => (
            <TouchableOpacity key={u.id} style={styles.userCard} onPress={() => showActionMenu(u)} activeOpacity={0.7}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.name}</Text>
                <Text style={styles.userMeta}>@{u.username}</Text>
              </View>
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>{ROLE_LABELS[u.role] || u.role}</Text>
              </View>
            </TouchableOpacity>
          ))
        )}

        {inactiveUsers.length > 0 && (
          <>
            <Text style={styles.inactiveHeader}>Inactive</Text>
            {inactiveUsers.map(u => (
              <TouchableOpacity key={u.id} style={[styles.userCard, styles.inactiveCard]} onPress={() => showActionMenu(u)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.userName, { color: COLORS.textTertiary }]}>{u.name}</Text>
                  <Text style={styles.userMeta}>@{u.username} · Deactivated</Text>
                </View>
                <View style={[styles.roleBadge, { backgroundColor: COLORS.divider }]}>
                  <Text style={[styles.roleBadgeText, { color: COLORS.textTertiary }]}>{ROLE_LABELS[u.role] || u.role}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Settings & SLA Thresholds</Text>

        <Text style={styles.inputLabel}>Gone Quiet Threshold (days)</Text>
        <TextInput style={styles.settingInput} value={thresholdInput} onChangeText={setThresholdInput} keyboardType="numeric" placeholder="30" placeholderTextColor={COLORS.textTertiary} />

        <View style={styles.divider} />
        <Text style={styles.subsectionTitle}>SLA Thresholds</Text>

        <Text style={styles.inputLabel}>Sales Escalation Ceiling (days)</Text>
        <TextInput style={styles.settingInput} value={slaEscInput} onChangeText={setSlaEscInput} keyboardType="numeric" placeholder="10" placeholderTextColor={COLORS.textTertiary} />

        <Text style={styles.inputLabel}>Accounts Processing SLA (days)</Text>
        <TextInput style={styles.settingInput} value={slaAccInput} onChangeText={setSlaAccInput} keyboardType="numeric" placeholder="3" placeholderTextColor={COLORS.textTertiary} />

        <Text style={styles.inputLabel}>Dispatch Completion SLA (days)</Text>
        <TextInput style={styles.settingInput} value={slaDispInput} onChangeText={setSlaDispInput} keyboardType="numeric" placeholder="7" placeholderTextColor={COLORS.textTertiary} />

        <TouchableOpacity style={[styles.saveBtn, savingSettings && { opacity: 0.7 }]} onPress={handleSaveSettings} disabled={savingSettings}>
          {savingSettings ? <ActivityIndicator color={COLORS.white} size="small" /> : <Text style={styles.saveBtnText}>Save All Settings</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Export</Text>
        <ExportButton onExport={handleMasterExport} label="Export All Data (Excel)" fullWidth />
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>

    <ConfirmDialog
      visible={actionType === 'deactivate'}
      title="Deactivate Account"
      message={`Are you sure you want to deactivate ${actionTarget?.name}? They will no longer be able to log in.`}
      confirmText="Deactivate"
      onConfirm={handleDeactivate}
      onCancel={() => { setActionTarget(null); setActionType(null); }}
      destructive
    />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingTop: SAFE_TOP + 16, paddingBottom: 120 },
  pageTitle: { fontSize: 24, fontFamily: 'Inter_700Bold', color: COLORS.primary, marginBottom: 4 },
  pageSubtitle: { fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 28 },
  section: { backgroundColor: COLORS.surface, borderRadius: 20, padding: 20, marginBottom: 16, shadowColor: COLORS.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 3 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', color: COLORS.textPrimary, marginBottom: 12 },
  subsectionTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 12 },
  addBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  addBtnText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.white },
  addForm: { backgroundColor: COLORS.background, borderRadius: 16, padding: 16, marginBottom: 16 },
  formInput: { backgroundColor: COLORS.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 10 },
  roleLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 8, marginLeft: 2 },
  rolePicker: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  roleOption: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  roleOptionActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  roleOptionText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  roleOptionTextActive: { color: COLORS.white },
  createBtn: { backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  createBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, textAlign: 'center', paddingVertical: 20 },
  userCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  inactiveCard: { opacity: 0.6 },
  userName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  userMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 2 },
  roleBadge: { backgroundColor: COLORS.primaryLight, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  roleBadgeText: { fontSize: 11, fontFamily: 'Inter_700Bold', color: COLORS.white },
  inactiveHeader: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textTertiary, marginTop: 16, marginBottom: 4 },
  inputLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary, marginBottom: 6, marginLeft: 2 },
  settingInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 14 },
  divider: { height: 1, backgroundColor: COLORS.divider, marginVertical: 16 },
  saveBtn: { backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  saveBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
