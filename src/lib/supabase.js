import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Supabase config missing. Create a .env file at the project root using ' +
    '.env.example as a template, then restart Expo with `npx expo start --clear`.',
  );
}

// AsyncStorage on native; built-in localStorage adapter on web.
// react-native-web's AsyncStorage shim already routes to localStorage,
// but Supabase prefers explicit configuration so it knows the storage is
// async vs. sync. The wrapper below works for both.
const storage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    // On native, we explicitly tell Supabase that we control the URL flow
    // (no browser redirect). On web we still don't need URL-based session
    // detection because we're using email/password.
    detectSessionInUrl: Platform.OS === 'web',
  },
  global: {
    // Hard timeout on every Supabase HTTP request. Without this, a flaky
    // connection (Wi-Fi blip, Supabase momentary slowness, etc.) can leave
    // requests pending indefinitely — that's what was making the "Submit
    // Query" / "Mark Booked" buttons spin forever. 15 s is generous; real
    // calls complete in 100-500 ms.
    fetch: (url, options = {}) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
    },
  },
});

/**
 * Helper: subscribe to a Postgres-changes channel for a given table.
 * Returns the subscription so the caller can unsubscribe in useEffect cleanup.
 *
 * Each call creates a UNIQUE channel name so two screens can subscribe to
 * the same table without colliding ("cannot add postgres_changes callbacks
 * after subscribe()" error).
 *
 * Usage:
 *   const sub = subscribeToTable('queries', '*', (payload) => { ... });
 *   return () => sub.unsubscribe();
 */
let _channelCounter = 0;
export function subscribeToTable(table, event, callback) {
  _channelCounter += 1;
  const channelName = `public:${table}:${_channelCounter}`;
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      { event, schema: 'public', table },
      callback,
    )
    .subscribe((status, err) => {
      // Surface silent subscription failures in the console so we can spot
      // mis-configured Realtime tables. Healthy: status === 'SUBSCRIBED'.
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(
          `[Realtime] ${channelName} → ${status}${err ? `: ${err.message}` : ''}. ` +
          `Check that the "${table}" table is in the supabase_realtime publication.`
        );
      }
    });
  return channel;
}
