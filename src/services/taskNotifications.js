import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy-load expo-notifications so we don't crash on web (where the module
// is a no-op or unavailable) and so a missing native build doesn't break
// the bundler.
let Notifications = null;
try {
  // eslint-disable-next-line global-require
  Notifications = require('expo-notifications');
} catch (e) {
  Notifications = null;
}

const STORAGE_KEY = 'taskNotificationIds:v1';

// Default "fire times" for date-only tasks. The user picked 6 PM at-due
// with "1 hour before" being 5 PM the same day.
const AT_DUE_HOUR = 18;     // 6 PM
const BEFORE_DUE_HOUR = 17; // 5 PM

function isSupported() {
  return Notifications && Platform.OS !== 'web';
}

/**
 * Read the previously-scheduled notification IDs from local storage. We
 * persist them so we can cancel them on the next sync without holding the
 * full list in memory across cold starts.
 */
async function loadScheduled() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

async function saveScheduled(ids) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ids || []));
  } catch (e) { /* ignore */ }
}

/**
 * Cancel every notification we previously scheduled for tasks. Safe to call
 * even when expo-notifications isn't available (no-op).
 */
async function cancelAllPrevious() {
  if (!isSupported()) return;
  const ids = await loadScheduled();
  for (const id of ids) {
    try { await Notifications.cancelScheduledNotificationAsync(id); }
    catch (e) { /* ignore — id might already be gone */ }
  }
  await saveScheduled([]);
}

/**
 * Build the two trigger Date objects (before-due, at-due) for a given task.
 * Returns null if the task isn't a candidate (no date, already completed,
 * or both fire times are in the past).
 */
function computeFireDates(task) {
  const due = task.nextDueDate || task.dueDate;
  if (!due) return null;
  if (task.isCompleted) return null;

  const atDue = new Date(due);
  atDue.setHours(AT_DUE_HOUR, 0, 0, 0);

  const beforeDue = new Date(due);
  beforeDue.setHours(BEFORE_DUE_HOUR, 0, 0, 0);

  const now = Date.now();
  return {
    beforeDue: beforeDue.getTime() > now ? beforeDue : null,
    atDue: atDue.getTime() > now ? atDue : null,
  };
}

async function ensurePermissions() {
  if (!isSupported()) return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const { status: askStatus } = await Notifications.requestPermissionsAsync();
    return askStatus === 'granted';
  } catch (e) {
    return false;
  }
}

/**
 * Re-synchronise scheduled notifications for the user's inbox. Cancels
 * everything we previously scheduled and re-schedules for the current set.
 * Idempotent — safe to call on every tasks update.
 *
 * Skipping the persistence layer is fine: missing notifications just won't
 * fire, but the in-app bell + the next sync (on app foreground) catch up.
 */
export async function syncTaskNotifications(tasks) {
  if (!isSupported()) return;
  const ok = await ensurePermissions();
  if (!ok) return;

  await cancelAllPrevious();

  const newIds = [];
  for (const t of tasks || []) {
    const fires = computeFireDates(t);
    if (!fires) continue;

    const settings = t.notifySettings || { before_due_hours: 1, at_due: true };

    if (settings.at_due && fires.atDue) {
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Task due today',
            body: t.title,
            data: { taskId: t.id, kind: 'at_due' },
          },
          trigger: fires.atDue,
        });
        newIds.push(id);
      } catch (e) { /* skip individual failures */ }
    }

    if ((settings.before_due_hours || 0) > 0 && fires.beforeDue) {
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Task due in 1 hour',
            body: t.title,
            data: { taskId: t.id, kind: 'before_due' },
          },
          trigger: fires.beforeDue,
        });
        newIds.push(id);
      } catch (e) { /* skip */ }
    }
  }

  await saveScheduled(newIds);
}
