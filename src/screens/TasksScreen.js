import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { COLORS, SAFE_TOP, ROLES } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import { subscribeToMyTasks, createTask, toggleTask } from '../services/tasksService';
import { getAllUsers } from '../services/authService';
import { relativeTime } from '../utils/timeUtils';
import BottomSheet from '../components/BottomSheet';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import SearchableDropdown from '../components/SearchableDropdown';
import Toast from 'react-native-toast-message';

const TABS = [
  { key: 'inbox', label: 'Assigned to me' },
  { key: 'sent',  label: 'I assigned' },
];

export default function TasksScreen() {
  const { userId, isOwner } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState('inbox');
  const [showNew, setShowNew] = useState(false);
  const [recipient, setRecipient] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!userId) return undefined;
    const unsub = subscribeToMyTasks(userId, setTasks);
    return unsub;
  }, [userId]);

  useEffect(() => {
    getAllUsers().then(setUsers).catch(console.error);
  }, []);

  // Owner can assign to ANY active non-owner; non-owners can only assign to owner.
  const recipientChoices = useMemo(() => {
    return users
      .filter(u => u.isActive !== false && u.id !== userId)
      .filter(u => isOwner ? true : u.role === ROLES.OWNER)
      .map(u => ({ id: u.id, name: `${u.name} (${u.role})` }));
  }, [users, isOwner, userId]);

  const filtered = useMemo(() => {
    if (tab === 'inbox') return tasks.filter(t => t.toUserId === userId);
    return tasks.filter(t => t.fromUserId === userId);
  }, [tasks, tab, userId]);

  const unread = tasks.filter(t => t.toUserId === userId && !t.isCompleted).length;

  const handleCreate = async () => {
    if (!recipient) { Alert.alert('Required', 'Pick a recipient.'); return; }
    if (!title.trim()) { Alert.alert('Required', 'Enter a task title.'); return; }
    setSubmitting(true);
    try {
      await createTask(recipient.id, title.trim(), description.trim());
      setShowNew(false); setRecipient(null); setTitle(''); setDescription('');
      Toast.show({ type: 'success', text1: 'Task assigned', position: 'bottom' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (task) => {
    try { await toggleTask(task.id); } catch (e) { Alert.alert('Error', e.message); }
  };

  const renderItem = ({ item }) => (
    <View style={[styles.card, item.isCompleted && styles.cardDone]}>
      <View style={styles.cardTop}>
        <TouchableOpacity
          onPress={() => handleToggle(item)}
          style={[styles.checkbox, item.isCompleted && styles.checkboxChecked]}
        >
          {item.isCompleted && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, item.isCompleted && styles.titleDone]}>{item.title}</Text>
          {item.description ? (
            <Text style={styles.description}>{item.description}</Text>
          ) : null}
        </View>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>
          {tab === 'inbox' ? `From: ${item.fromUserName}` : `To: ${item.toUserName}`}
        </Text>
        <Text style={styles.metaText}>{relativeTime(item.createdAt)}</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Tasks</Text>
          <Text style={styles.headerSubtitle}>{unread} open</Text>
        </View>
        <NotificationBell style={{ marginRight: 8 }} />
        <TouchableOpacity style={styles.newBtn} onPress={() => setShowNew(true)}>
          <Text style={styles.newBtnText}>+ New Task</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabRow}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, filtered.length === 0 && styles.emptyList]}
        ListEmptyComponent={<EmptyState title="No tasks" message={tab === 'inbox' ? 'No tasks have been assigned to you.' : 'You haven\'t assigned any tasks yet.'} />}
        showsVerticalScrollIndicator={false}
      />

      <BottomSheet visible={showNew} title="New Task" onClose={() => setShowNew(false)}>
        <Text style={styles.sheetLabel}>Assign to *</Text>
        <SearchableDropdown
          data={recipientChoices}
          value={recipient}
          onSelect={setRecipient}
          placeholder={isOwner ? "Pick a team member..." : "Owner"}
        />
        <Text style={[styles.sheetLabel, { marginTop: 14 }]}>Title *</Text>
        <TextInput style={styles.sheetInput} placeholder="What needs to happen?"
          placeholderTextColor={COLORS.textTertiary} value={title} onChangeText={setTitle} />
        <Text style={styles.sheetLabel}>Details (optional)</Text>
        <TextInput style={[styles.sheetInput, { minHeight: 70 }]} placeholder="Any context they need…"
          placeholderTextColor={COLORS.textTertiary} value={description} onChangeText={setDescription} multiline />
        <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.primary }]} onPress={handleCreate} disabled={submitting}>
          {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Assign Task</Text>}
        </TouchableOpacity>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: SAFE_TOP + 8, paddingBottom: 12, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 8 },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  headerSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, marginTop: 2 },
  newBtn: { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  newBtnText: { color: COLORS.white, fontFamily: 'Inter_700Bold', fontSize: 12 },
  tabRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border },
  tabActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tabLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  tabLabelActive: { color: COLORS.white },
  list: { padding: 16, paddingBottom: 40 },
  emptyList: { flex: 1 },
  card: { backgroundColor: COLORS.surface, borderRadius: 14, padding: 14, marginBottom: 10 },
  cardDone: { opacity: 0.55 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkboxChecked: { backgroundColor: COLORS.completed, borderColor: COLORS.completed },
  checkmark: { color: COLORS.white, fontFamily: 'Inter_700Bold', fontSize: 14 },
  title: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: COLORS.textPrimary, marginBottom: 4 },
  titleDone: { textDecorationLine: 'line-through', color: COLORS.textSecondary },
  description: { fontSize: 13, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, lineHeight: 18 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.divider },
  metaText: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 6 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 12 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
});
