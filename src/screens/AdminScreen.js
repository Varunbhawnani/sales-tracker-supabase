import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { COLORS, ROLES, SAFE_TOP } from '../utils/constants';
import {
  createUser, deactivateUser, reactivateUser, subscribeToUsers, updateUserRole,
} from '../services/authService';
import {
  subscribeToGodowns, createGodown, renameGodown,
  setGodownActive, assignUserGodown,
} from '../services/godownService';
import {
  subscribeToResponsibilities, createResponsibility, updateResponsibility,
  deleteResponsibility,
} from '../services/responsibilitiesService';
import { subscribeToSettings, updateSettings } from '../services/settingsService';
import {
  useGodownFilter, FILTER_ALL, FILTER_UNASSIGNED,
} from '../contexts/GodownFilterContext';
import { getAllQueriesOnce } from '../services/queryService';
import { getLeaderboardData } from '../services/statsService';
import { getAllCustomers } from '../services/masterDataService';
import { exportAll } from '../services/exportService';
import ConfirmDialog from '../components/ConfirmDialog';
import ExportButton from '../components/ExportButton';
import LoadingState from '../components/LoadingState';
import BottomSheet from '../components/BottomSheet';
import Toast from 'react-native-toast-message';

// Roles the admin can assign. Packing and Dispatch are separate teams again
// (Operations was a temporary merge in migration 017 — undone in 018). The
// legacy OPERATIONS enum value is still rendered for any historical rows
// that haven't been re-roled yet.
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
  // Anyone still on 'operations' from migration 017 — usually demoted to
  // 'packing' by migration 018 but we still render the label.
  [ROLES.OPERATIONS]: 'Operations',
};

// FILTER_ALL / FILTER_UNASSIGNED are imported from GodownFilterContext so
// the AdminScreen chip and the global top-bar chip stay in lock-step.

export default function AdminScreen() {
  // Owner-wide godown filter — shared with the top-bar chip on every other
  // owner screen. Switching here also scopes the Feed, Owner Dashboard,
  // Leaderboard, Follow-Ups view.
  const { filterId: filterGodownId, setFilterId: setFilterGodownId } = useGodownFilter();
  const [users, setUsers] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [settings, setSettingsState] = useState({});
  const [loading, setLoading] = useState(true);

  // Add-user form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState(ROLES.SALESPERSON);
  const [newGodownId, setNewGodownId] = useState(null);
  const [creating, setCreating] = useState(false);

  // Settings inputs
  const [thresholdInput, setThresholdInput] = useState('30');
  const [slaEscInput, setSlaEscInput] = useState('10');
  const [slaAccInput, setSlaAccInput] = useState('3');
  const [slaDispInput, setSlaDispInput] = useState('7');
  const [savingSettings, setSavingSettings] = useState(false);

  // Godowns inputs
  const [showGodownForm, setShowGodownForm] = useState(false);
  const [newGodownName, setNewGodownName] = useState('');
  const [creatingGodown, setCreatingGodown] = useState(false);
  const [editingGodown, setEditingGodown] = useState(null); // {id, name}
  const [editingGodownName, setEditingGodownName] = useState('');

  // Confirm dialog (deactivate user)
  const [actionTarget, setActionTarget] = useState(null);
  const [actionType, setActionType] = useState(null);

  // Per-user godown assign sheet
  const [assignTarget, setAssignTarget] = useState(null);
  const [assigning, setAssigning] = useState(false);

  // Role responsibilities editor
  const [responsibilities, setResponsibilities] = useState([]);
  const [respRole, setRespRole] = useState(ROLES.SALESPERSON);
  const [respEditing, setRespEditing] = useState(null); // null | { id?, title, steps[] }
  const [savingResp, setSavingResp] = useState(false);

  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    // Three realtime subscriptions wired together — admin sees user creates,
    // godown CRUD, and settings changes live across owner sessions.
    const unsubUsers = subscribeToUsers((list) => {
      setUsers(list);
      setLoading(false);
    });
    const unsubGodowns = subscribeToGodowns((list) => setGodowns(list), { includeInactive: true });
    const unsubSettings = subscribeToSettings((s) => {
      setSettingsState(s);
      setThresholdInput(String(s.gonequietThresholdDays || 30));
      setSlaEscInput(String(s.slaEscalationDays || 10));
      setSlaAccInput(String(s.slaAccountsDays || 3));
      setSlaDispInput(String(s.slaDispatchDays || 7));
    });
    return () => { unsubUsers(); unsubGodowns(); unsubSettings(); };
  }, []);

  // Responsibilities subscription is keyed on the currently-selected role
  // pill (Sales / Accounts / Packing / Dispatch). Switching pills cleanly
  // tears down the old subscription before spinning up the new one.
  useEffect(() => {
    const unsub = subscribeToResponsibilities((list) => setResponsibilities(list), { role: respRole });
    return () => unsub();
  }, [respRole]);

  const activeGodowns = useMemo(() => godowns.filter((g) => g.isActive), [godowns]);
  const godownById = useMemo(() => {
    const m = {};
    godowns.forEach((g) => { m[g.id] = g; });
    return m;
  }, [godowns]);

  // Apply the godown filter to the user list.
  const filteredUsers = useMemo(() => {
    if (filterGodownId === FILTER_ALL) return users;
    if (filterGodownId === FILTER_UNASSIGNED) return users.filter((u) => !u.godownId);
    return users.filter((u) => u.godownId === filterGodownId);
  }, [users, filterGodownId]);

  const activeUsers = filteredUsers.filter((u) => u.isActive !== false && u.role !== ROLES.OWNER);
  const inactiveUsers = filteredUsers.filter((u) => u.isActive === false);

  // ─── Handlers ───────────────────────────────────────────────────────────
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
      await createUser(
        newName.trim(),
        newUsername.trim().toLowerCase(),
        newPassword,
        newRole,
        newGodownId,
      );
      Toast.show({
        type: 'success',
        text1: 'User created',
        text2: `${newName.trim()} (${ROLE_LABELS[newRole]}) can now log in.`,
        position: 'bottom',
      });
      setShowAddForm(false);
      setNewName(''); setNewUsername(''); setNewPassword('');
      setNewRole(ROLES.SALESPERSON);
      setNewGodownId(null);
    } catch (error) {
      const msg = (error.message || '').includes('already registered') || (error.message || '').includes('already in use') || (error.message || '').includes('already taken')
        ? 'This username is already taken.'
        : error.message;
      Alert.alert('Error', msg || 'Failed to create user.');
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
    } catch (error) {
      Alert.alert('Error', 'Failed to deactivate account.');
    }
  };

  const handleReactivate = async (user) => {
    try {
      await reactivateUser(user.id);
      Toast.show({ type: 'success', text1: `${user.name} reactivated`, position: 'bottom' });
    } catch (error) {
      Alert.alert('Error', 'Failed to reactivate.');
    }
  };

  const showActionMenu = (u) => {
    const isActive = u.isActive !== false;
    const buttons = [{ text: 'Cancel', style: 'cancel' }];
    buttons.push({
      text: 'Assign Godown',
      onPress: () => setAssignTarget(u),
    });
    buttons.push({
      text: 'Change Role',
      onPress: () => showRoleMenu(u),
    });
    buttons.push({
      text: isActive ? 'Deactivate' : 'Reactivate',
      style: isActive ? 'destructive' : 'default',
      onPress: () => {
        if (isActive) {
          setActionTarget(u);
          setActionType('deactivate');
        } else {
          handleReactivate(u);
        }
      },
    });
    Alert.alert(u.name, `Role: ${ROLE_LABELS[u.role] || u.role}${u.godownId ? `\nGodown: ${godownById[u.godownId]?.name || '—'}` : '\nGodown: Unassigned'}`, buttons);
  };

  // Sub-menu for the "Change Role" action above. Excludes the user's current
  // role and the owner role (only the original seed account is owner).
  const showRoleMenu = (u) => {
    const buttons = [{ text: 'Cancel', style: 'cancel' }];
    ROLE_OPTIONS.filter((r) => r.key !== u.role).forEach((r) => {
      buttons.push({
        text: r.label,
        onPress: async () => {
          try {
            await updateUserRole(u.id, r.key);
            Toast.show({ type: 'success', text1: `${u.name} → ${r.label}`, position: 'bottom' });
          } catch (e) {
            Alert.alert('Error', e.message || 'Failed to change role.');
          }
        },
      });
    });
    Alert.alert(`Change role: ${u.name}`, `Current: ${ROLE_LABELS[u.role] || u.role}`, buttons);
  };

  const handleAssign = async (godownId) => {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      await assignUserGodown(assignTarget.id, godownId);
      Toast.show({
        type: 'success',
        text1: godownId ? `Assigned to ${godownById[godownId]?.name || 'godown'}` : 'Godown cleared',
        position: 'bottom',
      });
      setAssignTarget(null);
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to assign godown.');
    } finally {
      setAssigning(false);
    }
  };

  const handleSaveSettings = async () => {
    const gq = parseInt(thresholdInput);
    const esc = parseInt(slaEscInput);
    const acc = parseInt(slaAccInput);
    const disp = parseInt(slaDispInput);
    if ([gq, esc, acc, disp].some((v) => isNaN(v) || v < 1)) {
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

  const handleCreateGodown = async () => {
    const name = newGodownName.trim();
    if (!name) {
      Alert.alert('Required', 'Godown name is required.');
      return;
    }
    setCreatingGodown(true);
    try {
      await createGodown(name);
      Toast.show({ type: 'success', text1: 'Godown added', position: 'bottom' });
      setShowGodownForm(false);
      setNewGodownName('');
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to add godown.');
    } finally {
      setCreatingGodown(false);
    }
  };

  const handleRenameGodown = async () => {
    if (!editingGodown) return;
    const name = editingGodownName.trim();
    if (!name) {
      Alert.alert('Required', 'Godown name is required.');
      return;
    }
    try {
      await renameGodown(editingGodown.id, name);
      Toast.show({ type: 'success', text1: 'Godown renamed', position: 'bottom' });
      setEditingGodown(null);
      setEditingGodownName('');
    } catch (e) {
      Alert.alert('Error', e.message || 'Rename failed.');
    }
  };

  const handleGodownAction = (g) => {
    Alert.alert(g.name, g.isActive ? 'Active godown.' : 'Inactive godown.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Rename',
        onPress: () => { setEditingGodown(g); setEditingGodownName(g.name); },
      },
      {
        text: g.isActive ? 'Deactivate' : 'Reactivate',
        style: g.isActive ? 'destructive' : 'default',
        onPress: async () => {
          try {
            await setGodownActive(g.id, !g.isActive);
            Toast.show({
              type: 'success',
              text1: g.isActive ? 'Godown deactivated' : 'Godown reactivated',
              position: 'bottom',
            });
          } catch (e) {
            Alert.alert('Error', e.message || 'Failed.');
          }
        },
      },
    ]);
  };

  // ─── Responsibilities handlers ────────────────────────────────────────
  const openNewResponsibility = () => {
    setRespEditing({ id: null, title: '', steps: [''] });
  };

  const openEditResponsibility = (r) => {
    setRespEditing({
      id: r.id,
      title: r.title,
      steps: r.steps.length > 0 ? [...r.steps] : [''],
    });
  };

  const updateRespStep = (idx, text) => {
    setRespEditing((cur) => {
      if (!cur) return cur;
      const next = [...cur.steps];
      next[idx] = text;
      return { ...cur, steps: next };
    });
  };

  const addRespStep = () => {
    setRespEditing((cur) => cur && { ...cur, steps: [...cur.steps, ''] });
  };

  const removeRespStep = (idx) => {
    setRespEditing((cur) => {
      if (!cur) return cur;
      const next = cur.steps.filter((_, i) => i !== idx);
      return { ...cur, steps: next.length ? next : [''] };
    });
  };

  const handleSaveResponsibility = async () => {
    if (!respEditing) return;
    const cleanTitle = (respEditing.title || '').trim();
    if (!cleanTitle) {
      Alert.alert('Required', 'Title is required.');
      return;
    }
    setSavingResp(true);
    try {
      if (respEditing.id) {
        await updateResponsibility(respEditing.id, {
          title: cleanTitle,
          steps: respEditing.steps,
        });
        Toast.show({ type: 'success', text1: 'Responsibility updated', position: 'bottom' });
      } else {
        await createResponsibility(respRole, cleanTitle, respEditing.steps);
        Toast.show({ type: 'success', text1: 'Responsibility added', position: 'bottom' });
      }
      setRespEditing(null);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to save responsibility.');
    } finally {
      setSavingResp(false);
    }
  };

  const handleDeleteResponsibility = async (r) => {
    Alert.alert(
      'Delete responsibility',
      `Remove "${r.title}" from the ${ROLE_LABELS[respRole]} role?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteResponsibility(r.id);
              Toast.show({ type: 'success', text1: 'Removed', position: 'bottom' });
            } catch (e) {
              Alert.alert('Error', e.message || 'Failed to delete.');
            }
          },
        },
      ],
    );
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

  // Convenience: show the filter chip label.
  const filterLabel = useMemo(() => {
    if (filterGodownId === FILTER_ALL) return 'All godowns';
    if (filterGodownId === FILTER_UNASSIGNED) return 'Unassigned';
    return godownById[filterGodownId]?.name || 'All godowns';
  }, [filterGodownId, godownById]);

  const openFilterMenu = () => {
    const buttons = [{ text: 'Cancel', style: 'cancel' }];
    buttons.push({ text: 'All godowns', onPress: () => setFilterGodownId(FILTER_ALL) });
    buttons.push({ text: 'Unassigned', onPress: () => setFilterGodownId(FILTER_UNASSIGNED) });
    activeGodowns.forEach((g) => {
      buttons.push({ text: g.name, onPress: () => setFilterGodownId(g.id) });
    });
    Alert.alert('Filter by godown', 'Pick a view to scope the user list.', buttons);
  };

  if (loading) return <LoadingState />;

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
      <Text style={styles.pageSubtitle}>Manage godowns, users, SLA thresholds & settings</Text>

      {/* ─── Godown filter chip ─── */}
      <TouchableOpacity style={styles.filterChip} onPress={openFilterMenu} activeOpacity={0.75}>
        <Text style={styles.filterChipLabel}>Viewing</Text>
        <Text style={styles.filterChipValue}>{filterLabel}</Text>
        <Text style={styles.filterChipCaret}>▾</Text>
      </TouchableOpacity>

      {/* ─── Section: Manage Users ─── */}
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
              {ROLE_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.roleOption, newRole === opt.key && styles.roleOptionActive]}
                  onPress={() => setNewRole(opt.key)}
                >
                  <Text style={[styles.roleOptionText, newRole === opt.key && styles.roleOptionTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.roleLabel}>Godown (optional)</Text>
            <View style={styles.godownPicker}>
              <TouchableOpacity
                style={[styles.godownChip, !newGodownId && styles.godownChipActive]}
                onPress={() => setNewGodownId(null)}
              >
                <Text style={[styles.godownChipText, !newGodownId && styles.godownChipTextActive]}>None</Text>
              </TouchableOpacity>
              {activeGodowns.map((g) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.godownChip, newGodownId === g.id && styles.godownChipActive]}
                  onPress={() => setNewGodownId(g.id)}
                >
                  <Text style={[styles.godownChipText, newGodownId === g.id && styles.godownChipTextActive]}>{g.name}</Text>
                </TouchableOpacity>
              ))}
              {activeGodowns.length === 0 && (
                <Text style={styles.emptyHint}>No godowns yet — add one below.</Text>
              )}
            </View>

            <TouchableOpacity style={[styles.createBtn, creating && { opacity: 0.7 }]} onPress={handleCreateUser} disabled={creating}>
              {creating ? <ActivityIndicator color={COLORS.white} size="small" /> : <Text style={styles.createBtnText}>Create Account</Text>}
            </TouchableOpacity>
          </View>
        )}

        {activeUsers.length === 0 ? (
          <Text style={styles.emptyText}>
            {filterGodownId === FILTER_ALL
              ? 'No active users. Tap + Add User to create one.'
              : 'No users in this view.'}
          </Text>
        ) : (
          activeUsers.map((u) => (
            <TouchableOpacity key={u.id} style={styles.userCard} onPress={() => showActionMenu(u)} activeOpacity={0.7}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.name}</Text>
                <Text style={styles.userMeta}>
                  @{u.username}
                  {u.godownId ? ` · ${godownById[u.godownId]?.name || '—'}` : ' · Unassigned'}
                </Text>
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
            {inactiveUsers.map((u) => (
              <TouchableOpacity key={u.id} style={[styles.userCard, styles.inactiveCard]} onPress={() => showActionMenu(u)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.userName, { color: COLORS.textTertiary }]}>{u.name}</Text>
                  <Text style={styles.userMeta}>
                    @{u.username} · Deactivated
                    {u.godownId ? ` · ${godownById[u.godownId]?.name || '—'}` : ''}
                  </Text>
                </View>
                <View style={[styles.roleBadge, { backgroundColor: COLORS.divider }]}>
                  <Text style={[styles.roleBadgeText, { color: COLORS.textTertiary }]}>{ROLE_LABELS[u.role] || u.role}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}
      </View>

      {/* ─── Section: Manage Godowns ─── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Manage Godowns</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowGodownForm(!showGodownForm)}>
            <Text style={styles.addBtnText}>{showGodownForm ? 'Close' : '+ Add Godown'}</Text>
          </TouchableOpacity>
        </View>

        {showGodownForm && (
          <View style={styles.addForm}>
            <TextInput
              style={styles.formInput}
              placeholder="Godown name (e.g., Sonipat)"
              placeholderTextColor={COLORS.textTertiary}
              value={newGodownName}
              onChangeText={setNewGodownName}
            />
            <TouchableOpacity style={[styles.createBtn, creatingGodown && { opacity: 0.7 }]} onPress={handleCreateGodown} disabled={creatingGodown}>
              {creatingGodown ? <ActivityIndicator color={COLORS.white} size="small" /> : <Text style={styles.createBtnText}>Add Godown</Text>}
            </TouchableOpacity>
          </View>
        )}

        {godowns.length === 0 ? (
          <Text style={styles.emptyText}>No godowns yet. Tap + Add Godown to create one.</Text>
        ) : (
          godowns.map((g) => (
            <TouchableOpacity
              key={g.id}
              style={[styles.godownRow, !g.isActive && styles.inactiveCard]}
              onPress={() => handleGodownAction(g)}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.userName, !g.isActive && { color: COLORS.textTertiary }]}>{g.name}</Text>
                <Text style={styles.userMeta}>
                  {users.filter((u) => u.godownId === g.id && u.isActive !== false).length} users
                  {g.isActive ? '' : ' · Inactive'}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* ─── Section: Role Responsibilities ─── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Role Responsibilities</Text>
          <TouchableOpacity style={styles.addBtn} onPress={openNewResponsibility}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.respHint}>
          Define what each role is responsible for and the steps to follow. Users see these in their portal as reference.
        </Text>

        {/* Role pills */}
        <View style={styles.rolePicker}>
          {ROLE_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.key}
              style={[styles.roleOption, respRole === opt.key && styles.roleOptionActive]}
              onPress={() => setRespRole(opt.key)}
            >
              <Text style={[styles.roleOptionText, respRole === opt.key && styles.roleOptionTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {responsibilities.length === 0 ? (
          <Text style={styles.emptyText}>
            No responsibilities for {ROLE_LABELS[respRole]} yet. Tap + Add to create one.
          </Text>
        ) : (
          responsibilities.map((r) => (
            <View key={r.id} style={styles.respRow}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => openEditResponsibility(r)} activeOpacity={0.7}>
                <Text style={styles.respTitle}>{r.title}</Text>
                <Text style={styles.respMeta}>
                  {r.steps.length} step{r.steps.length === 1 ? '' : 's'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDeleteResponsibility(r)} style={styles.respDeleteBtn}>
                <Text style={styles.respDeleteText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* ─── Section: Settings & SLA ─── */}
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

      {/* ─── Section: Export ─── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Export</Text>
        <ExportButton onExport={handleMasterExport} label="Export All Data (Excel)" fullWidth />
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>

    {/* ─── Confirm: Deactivate ─── */}
    <ConfirmDialog
      visible={actionType === 'deactivate'}
      title="Deactivate Account"
      message={`Are you sure you want to deactivate ${actionTarget?.name}? They will no longer be able to log in.`}
      confirmText="Deactivate"
      onConfirm={handleDeactivate}
      onCancel={() => { setActionTarget(null); setActionType(null); }}
      destructive
    />

    {/* ─── Sheet: Assign Godown ─── */}
    <BottomSheet
      visible={!!assignTarget}
      title={`Assign Godown — ${assignTarget?.name || ''}`}
      onClose={() => setAssignTarget(null)}
    >
      <View style={styles.assignList}>
        <TouchableOpacity
          style={[styles.assignRow, !assignTarget?.godownId && styles.assignRowActive]}
          onPress={() => handleAssign(null)}
          disabled={assigning}
        >
          <Text style={styles.assignRowText}>None (Unassigned)</Text>
          {!assignTarget?.godownId && <Text style={styles.assignTick}>✓</Text>}
        </TouchableOpacity>
        {activeGodowns.map((g) => (
          <TouchableOpacity
            key={g.id}
            style={[styles.assignRow, assignTarget?.godownId === g.id && styles.assignRowActive]}
            onPress={() => handleAssign(g.id)}
            disabled={assigning}
          >
            <Text style={styles.assignRowText}>{g.name}</Text>
            {assignTarget?.godownId === g.id && <Text style={styles.assignTick}>✓</Text>}
          </TouchableOpacity>
        ))}
        {activeGodowns.length === 0 && (
          <Text style={styles.emptyHint}>No godowns yet — add one in the Manage Godowns section.</Text>
        )}
      </View>
    </BottomSheet>

    {/* ─── Sheet: Rename Godown ─── */}
    <BottomSheet
      visible={!!editingGodown}
      title="Rename Godown"
      onClose={() => { setEditingGodown(null); setEditingGodownName(''); }}
    >
      <TextInput
        style={styles.formInput}
        value={editingGodownName}
        onChangeText={setEditingGodownName}
        autoFocus
      />
      <TouchableOpacity style={styles.saveBtn} onPress={handleRenameGodown}>
        <Text style={styles.saveBtnText}>Save</Text>
      </TouchableOpacity>
    </BottomSheet>

    {/* ─── Sheet: Responsibility editor (create + edit) ─── */}
    <BottomSheet
      visible={!!respEditing}
      title={respEditing?.id ? 'Edit Responsibility' : `New Responsibility (${ROLE_LABELS[respRole]})`}
      onClose={() => setRespEditing(null)}
    >
      <Text style={styles.respFieldLabel}>Title *</Text>
      <TextInput
        style={styles.formInput}
        value={respEditing?.title || ''}
        onChangeText={(t) => setRespEditing((cur) => cur && ({ ...cur, title: t }))}
        placeholder="e.g. Customer follow-up calls"
        placeholderTextColor={COLORS.textTertiary}
      />

      <Text style={styles.respFieldLabel}>Steps</Text>
      {(respEditing?.steps || []).map((step, idx) => (
        <View key={idx} style={styles.stepEditRow}>
          <View style={styles.stepBullet}>
            <Text style={styles.stepBulletText}>{idx + 1}</Text>
          </View>
          <TextInput
            style={[styles.formInput, { flex: 1, marginBottom: 0 }]}
            value={step}
            onChangeText={(t) => updateRespStep(idx, t)}
            placeholder="Describe this step"
            placeholderTextColor={COLORS.textTertiary}
            multiline
          />
          <TouchableOpacity onPress={() => removeRespStep(idx)} style={styles.stepRemoveBtn}>
            <Text style={styles.stepRemoveText}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity style={styles.addStepBtn} onPress={addRespStep}>
        <Text style={styles.addStepText}>+ Add Step</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.saveBtn, savingResp && { opacity: 0.7 }]}
        onPress={handleSaveResponsibility}
        disabled={savingResp}
      >
        {savingResp ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.saveBtnText}>Save</Text>}
      </TouchableOpacity>
    </BottomSheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingTop: SAFE_TOP + 16, paddingBottom: 120 },
  pageTitle: { fontSize: 24, fontFamily: 'Inter_700Bold', color: COLORS.primary, marginBottom: 4 },
  pageSubtitle: { fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginBottom: 16 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    marginBottom: 16,
    borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  filterChipLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary, marginRight: 8 },
  filterChipValue: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.primary, flex: 1 },
  filterChipCaret: { fontSize: 14, color: COLORS.primary },
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
  godownPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  godownChip: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  godownChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  godownChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  godownChipTextActive: { color: COLORS.white },
  createBtn: { backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  createBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, textAlign: 'center', paddingVertical: 20 },
  emptyHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, paddingVertical: 6 },
  userCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  inactiveCard: { opacity: 0.6 },
  userName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  userMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 2 },
  roleBadge: { backgroundColor: COLORS.primaryLight, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  roleBadgeText: { fontSize: 11, fontFamily: 'Inter_700Bold', color: COLORS.white },
  inactiveHeader: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textTertiary, marginTop: 16, marginBottom: 4 },
  godownRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  chevron: { fontSize: 20, color: COLORS.textTertiary, marginLeft: 8 },
  inputLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary, marginBottom: 6, marginLeft: 2 },
  settingInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 14 },
  divider: { height: 1, backgroundColor: COLORS.divider, marginVertical: 16 },
  saveBtn: { backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  saveBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: COLORS.white },
  assignList: { paddingBottom: 8 },
  assignRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  assignRowActive: {},
  assignRowText: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium', color: COLORS.textPrimary },
  assignTick: { fontSize: 16, color: COLORS.primary, fontFamily: 'Inter_700Bold' },
  respHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginBottom: 12, lineHeight: 18 },
  respRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  respTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary },
  respMeta: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginTop: 2 },
  respDeleteBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  respDeleteText: { fontSize: 16, color: COLORS.danger },
  respFieldLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 6, marginTop: 4, marginLeft: 2 },
  stepEditRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  stepBullet: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  stepBulletText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  stepRemoveBtn: { padding: 8, marginTop: 4 },
  stepRemoveText: { fontSize: 14, color: COLORS.danger, fontFamily: 'Inter_600SemiBold' },
  addStepBtn: {
    borderRadius: 10, paddingVertical: 10, alignItems: 'center',
    borderWidth: 1, borderColor: COLORS.border, borderStyle: 'dashed',
    backgroundColor: COLORS.background, marginBottom: 14, marginTop: 4,
  },
  addStepText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.primary },
});
