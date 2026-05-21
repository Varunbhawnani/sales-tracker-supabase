import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet,
  Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { COLORS, SAFE_TOP, ROLES } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';
import {
  subscribeToMyTasks, createTask, toggleTask, describeRecurrence,
} from '../services/tasksService';
import { getAllUsers } from '../services/authService';
import { relativeTime } from '../utils/timeUtils';
import BottomSheet from '../components/BottomSheet';
import PlatformDatePicker from '../components/PlatformDatePicker';
import EmptyState from '../components/EmptyState';
import NotificationBell from '../components/NotificationBell';
import SearchableDropdown from '../components/SearchableDropdown';
import Toast from 'react-native-toast-message';
import { syncTaskNotifications } from '../services/taskNotifications';

const TABS = [
  { key: 'inbox', label: 'Assigned to me' },
  { key: 'sent',  label: 'I assigned' },
];

const RECURRENCE_OPTIONS = [
  { key: 'one_time',     label: 'One-time' },
  { key: 'days',         label: 'Every N days' },
  { key: 'weekday',      label: 'Specific weekdays' },
  { key: 'day_of_month', label: 'Day of month' },
];

const WEEKDAYS = [
  { id: 1, label: 'Mon' }, { id: 2, label: 'Tue' }, { id: 3, label: 'Wed' },
  { id: 4, label: 'Thu' }, { id: 5, label: 'Fri' }, { id: 6, label: 'Sat' },
  { id: 7, label: 'Sun' },
];

function toISO(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export default function TasksScreen({ navigation }) {
  const { userId, isOwner } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState('inbox');
  const [showNew, setShowNew] = useState(false);

  // New task form state
  const [recipient, setRecipient] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(null);
  const [showDuePicker, setShowDuePicker] = useState(false);
  const [recType, setRecType] = useState('one_time');
  const [recInterval, setRecInterval] = useState('1');
  const [recWeekdays, setRecWeekdays] = useState([1]); // default Mon
  const [recDayOfMonth, setRecDayOfMonth] = useState('1');
  const [recStartDate, setRecStartDate] = useState(null);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [recEndDate, setRecEndDate] = useState(null);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!userId) return undefined;
    const unsub = subscribeToMyTasks(userId, setTasks);
    return unsub;
  }, [userId]);

  useEffect(() => {
    getAllUsers().then(setUsers).catch(console.error);
  }, []);

  // Whenever the inbox list changes, re-sync scheduled local notifications.
  // Two reminders per task with a due date: 5 PM same day (1 hour before
  // the default 6 PM fire time) and 6 PM same day. Completed tasks are
  // skipped. Older expired schedules are cleared by syncTaskNotifications.
  useEffect(() => {
    const myInbox = tasks.filter((t) => t.toUserId === userId);
    syncTaskNotifications(myInbox).catch((e) => console.warn('schedule failed', e?.message || e));
  }, [tasks, userId]);

  // Owner can assign to ANY active non-owner; non-owners can only assign to owner.
  const recipientChoices = useMemo(() => {
    return users
      .filter(u => u.isActive !== false && u.id !== userId)
      .filter(u => isOwner ? true : u.role === ROLES.OWNER)
      .map(u => ({ id: u.id, name: `${u.name} (${u.role})` }));
  }, [users, isOwner, userId]);

  // Sort: open + with a due date come first, ordered by upcoming due date;
  // undated open tasks next; completed last.
  const sortedTasks = useMemo(() => {
    const arr = [...tasks];
    arr.sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      const da = (a.nextDueDate || a.dueDate);
      const db = (b.nextDueDate || b.dueDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.getTime() - db.getTime();
    });
    return arr;
  }, [tasks]);

  const filtered = useMemo(() => {
    if (tab === 'inbox') return sortedTasks.filter(t => t.toUserId === userId);
    return sortedTasks.filter(t => t.fromUserId === userId);
  }, [sortedTasks, tab, userId]);

  const unread = tasks.filter(t => t.toUserId === userId && !t.isCompleted).length;

  const resetForm = () => {
    setRecipient(null); setTitle(''); setDescription('');
    setDueDate(null); setRecType('one_time'); setRecInterval('1');
    setRecWeekdays([1]); setRecDayOfMonth('1');
    setRecStartDate(null); setRecEndDate(null);
  };

  const buildRecurrence = () => {
    if (recType === 'one_time') return null;
    const base = {
      type: recType,
      interval: Math.max(1, parseInt(recInterval, 10) || 1),
      start_date: toISO(recStartDate) || toISO(new Date()),
      end_date: toISO(recEndDate),
    };
    if (recType === 'weekday') {
      const wd = (recWeekdays || []).slice().sort((a, b) => a - b);
      if (wd.length === 0) {
        Alert.alert('Pick weekdays', 'Choose at least one weekday for the recurrence.');
        return undefined;
      }
      base.weekdays = wd;
    }
    if (recType === 'day_of_month') {
      const dom = parseInt(recDayOfMonth, 10) || 1;
      if (dom < 1 || dom > 28) {
        Alert.alert('Invalid day', 'Day of month must be between 1 and 28 (Feb-safe).');
        return undefined;
      }
      base.day_of_month = dom;
    }
    return base;
  };

  const handleCreate = async () => {
    if (!recipient) { Alert.alert('Required', 'Pick a recipient.'); return; }
    if (!title.trim()) { Alert.alert('Required', 'Enter a task title.'); return; }
    const recurrence = buildRecurrence();
    if (recurrence === undefined) return; // validation alert already shown

    setSubmitting(true);
    try {
      await createTask(recipient.id, title.trim(), description.trim(), {
        dueDate,
        recurrence,
        notifySettings: { on_assign: true, before_due_hours: 1, at_due: true },
      });
      setShowNew(false);
      resetForm();
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

  const toggleWeekday = (id) => {
    setRecWeekdays((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return [...cur, id];
    });
  };

  const renderItem = ({ item }) => {
    const due = item.nextDueDate || item.dueDate;
    const overdue = due && !item.isCompleted && due.getTime() < (Date.now() - 24 * 3600 * 1000);
    const dueChip = due
      ? due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;
    const recChip = describeRecurrence(item.recurrence);

    return (
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
            <View style={styles.chipRow}>
              {dueChip && (
                <View style={[styles.chip, overdue && styles.chipOverdue]}>
                  <Text style={[styles.chipText, overdue && styles.chipTextOverdue]}>
                    📅 {dueChip}{overdue ? ' · overdue' : ''}
                  </Text>
                </View>
              )}
              {item.recurrence && (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>🔁 {recChip}</Text>
                </View>
              )}
            </View>
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
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Tasks</Text>
          <Text style={styles.headerSubtitle}>{unread} open</Text>
        </View>
        <TouchableOpacity
          style={[styles.newBtn, { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border, marginRight: 4 }]}
          onPress={() => navigation?.navigate?.('Responsibilities')}
        >
          <Text style={[styles.newBtnText, { color: COLORS.textSecondary }]}>📋</Text>
        </TouchableOpacity>
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

      <BottomSheet visible={showNew} title="New Task" onClose={() => { setShowNew(false); resetForm(); }}>
        <ScrollView style={{ maxHeight: 480 }} keyboardShouldPersistTaps="handled">
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
          <TextInput style={[styles.sheetInput, { minHeight: 60 }]} placeholder="Any context they need…"
            placeholderTextColor={COLORS.textTertiary} value={description} onChangeText={setDescription} multiline />

          {/* Recurrence type pills */}
          <Text style={styles.sheetLabel}>Recurrence</Text>
          <View style={styles.pillRow}>
            {RECURRENCE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.pill, recType === opt.key && styles.pillActive]}
                onPress={() => setRecType(opt.key)}
              >
                <Text style={[styles.pillText, recType === opt.key && styles.pillTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {recType === 'one_time' && (
            <>
              <Text style={styles.sheetLabel}>Due date</Text>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setShowDuePicker(true)}>
                <Text style={{ color: dueDate ? COLORS.textPrimary : COLORS.textTertiary, fontFamily: 'Inter_500Medium' }}>
                  {dueDate
                    ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                    : 'Pick a date (optional)'}
                </Text>
              </TouchableOpacity>
              {dueDate && (
                <TouchableOpacity onPress={() => setDueDate(null)} style={{ marginBottom: 8 }}>
                  <Text style={{ color: COLORS.danger, fontSize: 12 }}>Clear date</Text>
                </TouchableOpacity>
              )}
              {showDuePicker && (
                <PlatformDatePicker
                  value={dueDate || new Date()}
                  mode="date"
                  minimumDate={new Date()}
                  onChange={(d) => { setShowDuePicker(false); if (d) setDueDate(d); }}
                  onCancel={() => setShowDuePicker(false)}
                />
              )}
            </>
          )}

          {recType === 'days' && (
            <>
              <Text style={styles.sheetLabel}>Every N days</Text>
              <TextInput
                style={styles.sheetInput}
                value={recInterval}
                onChangeText={(t) => setRecInterval(t.replace(/[^0-9]/g, ''))}
                keyboardType="numeric"
                placeholder="7"
                placeholderTextColor={COLORS.textTertiary}
              />
              <Text style={styles.sheetHelper}>e.g. 7 = weekly, 14 = bi-weekly. Counted from the start date.</Text>
            </>
          )}

          {recType === 'weekday' && (
            <>
              <Text style={styles.sheetLabel}>Weekdays</Text>
              <View style={styles.pillRow}>
                {WEEKDAYS.map((w) => (
                  <TouchableOpacity
                    key={w.id}
                    style={[styles.pill, recWeekdays.includes(w.id) && styles.pillActive]}
                    onPress={() => toggleWeekday(w.id)}
                  >
                    <Text style={[styles.pillText, recWeekdays.includes(w.id) && styles.pillTextActive]}>{w.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.sheetHelper}>Task fires on each picked weekday.</Text>
            </>
          )}

          {recType === 'day_of_month' && (
            <>
              <Text style={styles.sheetLabel}>Day of month (1–28)</Text>
              <TextInput
                style={styles.sheetInput}
                value={recDayOfMonth}
                onChangeText={(t) => setRecDayOfMonth(t.replace(/[^0-9]/g, ''))}
                keyboardType="numeric"
                placeholder="1"
                placeholderTextColor={COLORS.textTertiary}
              />
              <Text style={styles.sheetLabel}>Every N months</Text>
              <TextInput
                style={styles.sheetInput}
                value={recInterval}
                onChangeText={(t) => setRecInterval(t.replace(/[^0-9]/g, ''))}
                keyboardType="numeric"
                placeholder="1"
                placeholderTextColor={COLORS.textTertiary}
              />
              <Text style={styles.sheetHelper}>1 = every month, 3 = quarterly, etc.</Text>
            </>
          )}

          {recType !== 'one_time' && (
            <>
              <Text style={styles.sheetLabel}>Start date</Text>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setShowStartPicker(true)}>
                <Text style={{ color: recStartDate ? COLORS.textPrimary : COLORS.textTertiary, fontFamily: 'Inter_500Medium' }}>
                  {recStartDate
                    ? recStartDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                    : 'Today (default)'}
                </Text>
              </TouchableOpacity>
              {showStartPicker && (
                <PlatformDatePicker
                  value={recStartDate || new Date()}
                  mode="date"
                  onChange={(d) => { setShowStartPicker(false); if (d) setRecStartDate(d); }}
                  onCancel={() => setShowStartPicker(false)}
                />
              )}

              <Text style={styles.sheetLabel}>End date (optional)</Text>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setShowEndPicker(true)}>
                <Text style={{ color: recEndDate ? COLORS.textPrimary : COLORS.textTertiary, fontFamily: 'Inter_500Medium' }}>
                  {recEndDate
                    ? recEndDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                    : 'No end date (open-ended)'}
                </Text>
              </TouchableOpacity>
              {recEndDate && (
                <TouchableOpacity onPress={() => setRecEndDate(null)} style={{ marginBottom: 8 }}>
                  <Text style={{ color: COLORS.danger, fontSize: 12 }}>Clear end date</Text>
                </TouchableOpacity>
              )}
              {showEndPicker && (
                <PlatformDatePicker
                  value={recEndDate || new Date(Date.now() + 30 * 86400000)}
                  mode="date"
                  minimumDate={recStartDate || new Date()}
                  onChange={(d) => { setShowEndPicker(false); if (d) setRecEndDate(d); }}
                  onCancel={() => setShowEndPicker(false)}
                />
              )}
            </>
          )}

          <Text style={styles.sheetHelper}>
            Notifications fire at 5 PM (1 hour before) and 6 PM on the due date. The recipient also gets an in-app notification right when assigned.
          </Text>

          <TouchableOpacity style={[styles.sheetButton, { backgroundColor: COLORS.primary }]} onPress={handleCreate} disabled={submitting}>
            {submitting ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sheetButtonText}>Assign Task</Text>}
          </TouchableOpacity>
        </ScrollView>
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { backgroundColor: COLORS.background, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: COLORS.border },
  chipOverdue: { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' },
  chipText: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary },
  chipTextOverdue: { color: COLORS.danger, fontFamily: 'Inter_700Bold' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.divider },
  metaText: { fontSize: 11, fontFamily: 'Inter_500Medium', color: COLORS.textTertiary },
  sheetLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary, marginBottom: 6, marginTop: 8 },
  sheetHelper: { fontSize: 11, fontFamily: 'Inter_400Regular', color: COLORS.textTertiary, marginBottom: 12, lineHeight: 16 },
  sheetInput: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular', color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.border, marginBottom: 8 },
  sheetButton: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12, marginBottom: 8 },
  sheetButtonText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: COLORS.white },
  dateBtn: { backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.border, marginBottom: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  pillActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pillText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  pillTextActive: { color: COLORS.white },
});
