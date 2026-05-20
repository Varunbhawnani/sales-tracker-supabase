/**
 * Notification Service — same Expo-Notifications gymnastics as the Firebase
 * version. Push tokens are stored on the users table (expo_push_token column).
 *
 * Note: Supabase doesn't have an equivalent to Firebase Cloud Messaging, so
 * we still send pushes through Expo's push service (https://exp.host/...).
 * That part is unchanged from the Firebase project.
 */
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

const isExpoGo = Constants.appOwnership === 'expo';

let Notifications = null;
if (!isExpoGo) {
  try { Notifications = require('expo-notifications'); } catch (e) { /* silent */ }
}

if (Notifications) {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
      }),
    });
  } catch (e) { /* silent */ }
}

export async function registerForPushNotifications() {
  if (!Notifications || isExpoGo) return null;
  if (!Device.isDevice) return null;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return null;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#1A3C6E',
      });
    }
    return token;
  } catch (error) {
    console.warn('Error getting push token:', error.message);
    return null;
  }
}

export async function savePushToken(userId, token) {
  if (!userId || !token) return;
  const { error } = await supabase.from('users').update({ expo_push_token: token }).eq('id', userId);
  if (error) console.error('savePushToken error:', error);
}

/**
 * Notify salespersons + owners when a new query is created.
 * Reads tokens via Supabase, then POSTs to Expo's push service in batches of 90.
 */
export async function sendNewQueryNotification(partyName, sets, queryId, excludeUserId) {
  try {
    const { data: users } = await supabase
      .from('users')
      .select('id, expo_push_token, is_active, role')
      .neq('id', excludeUserId)
      .eq('is_active', true)
      .in('role', ['salesperson', 'owner'])
      .not('expo_push_token', 'is', null);

    const tokens = (users || []).map(u => u.expo_push_token).filter(Boolean);
    if (tokens.length === 0) return;

    const messages = tokens.map(token => ({
      to: token, sound: 'default',
      title: 'New Query', body: `${partyName} — ${sets} Sets`,
      data: { queryId },
    }));

    const CHUNK = 90;
    for (let i = 0; i < messages.length; i += CHUNK) {
      const messageChunk = messages.slice(i, i + CHUNK);
      const tokenChunk = tokens.slice(i, i + CHUNK);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(messageChunk),
      });
      const result = await response.json();
      if (result.data) {
        for (let j = 0; j < result.data.length; j++) {
          const item = result.data[j];
          if (item.status === 'error' && item.details?.error === 'DeviceNotRegistered') {
            const invalidToken = tokenChunk[j];
            try {
              await supabase.from('users').update({ expo_push_token: null })
                .eq('expo_push_token', invalidToken);
            } catch (e) { /* silent */ }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error sending push notification:', error);
  }
}

export function setupNotificationResponseListener(navigation) {
  if (!Notifications || isExpoGo) return null;
  try {
    return Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data?.queryId) {
        navigation.navigate('FeedStack', { screen: 'QueryDetail', params: { queryId: data.queryId } });
      }
    });
  } catch (e) { return null; }
}

export function setupTokenRefreshListener(userId) {
  if (!Notifications || isExpoGo) return null;
  try {
    return Notifications.addPushTokenListener(async (newToken) => {
      if (userId && newToken?.data) await savePushToken(userId, newToken.data);
    });
  } catch (e) { return null; }
}
