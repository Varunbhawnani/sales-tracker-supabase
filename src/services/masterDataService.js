import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

// Same delta-sync watermark strategy as the Firebase version's lastSynced fix.
// Postgres makes this even simpler: the `last_synced` column is a real
// timestamp and we can query `where last_synced > X` directly.
const CUSTOMERS_CACHE_KEY = 'cache:customers_master:v1';
const PRODUCTS_CACHE_KEY = 'cache:products_master:v1';
const CUSTOMERS_LAST_SYNCED_KEY = 'cache:customers_master:lastSyncedAt';
const PRODUCTS_LAST_SYNCED_KEY = 'cache:products_master:lastSyncedAt';
const CUSTOMERS_LAST_FULL_SYNC_KEY = 'cache:customers_master:lastFullSync';
const PRODUCTS_LAST_FULL_SYNC_KEY = 'cache:products_master:lastFullSync';

const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function rowToCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    guid: row.guid,
    category: row.category,
    priceLevel: row.price_level,
    parentGroup: row.parent_group,
    tallyAlterId: row.tally_alter_id,
    lastSynced: row.last_synced,
  };
}
function rowToProduct(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku || '',
    guid: row.guid,
    tallyAlterId: row.tally_alter_id,
    unitType: row.unit_type,
    price: Number(row.price || 0),
    priceTiers: row.price_tiers || {},
    lastSynced: row.last_synced,
  };
}

export async function getAllCustomers() {
  const { data, error } = await supabase
    .from('customers_master').select('*').order('name');
  if (error) throw error;
  return data.map(rowToCustomer);
}
export async function getAllProducts() {
  const { data, error } = await supabase
    .from('products_master').select('*').order('name');
  if (error) throw error;
  return data.map(rowToProduct);
}

export async function getCachedCustomers() {
  try {
    const raw = await AsyncStorage.getItem(CUSTOMERS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
export async function getCachedProducts() {
  try {
    const raw = await AsyncStorage.getItem(PRODUCTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function readNumberFromStorage(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

function mergeAndSort(existing, updates) {
  const map = new Map();
  existing.forEach(d => map.set(d.id, d));
  updates.forEach(d => map.set(d.id, d));
  return Array.from(map.values()).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );
}

async function fullSyncProgressive(table, mapper, onBatch, batchSize = 500) {
  let from = 0;
  let accumulated = [];
  while (true) {
    const { data, error } = await supabase
      .from(table).select('*')
      .order('name', { ascending: true })
      .range(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    accumulated = accumulated.concat(data.map(mapper));
    onBatch(accumulated);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return accumulated;
}

/**
 * Sync customers using last_synced as the watermark.
 */
async function syncCollection({
  table, mapper, cacheKey, lastSyncedKey, lastFullSyncKey, onBatch,
}) {
  const [cachedRaw, storedLastSyncedMs, lastFullSyncMs] = await Promise.all([
    AsyncStorage.getItem(cacheKey),
    readNumberFromStorage(lastSyncedKey),
    readNumberFromStorage(lastFullSyncKey),
  ]);
  const cached = cachedRaw ? JSON.parse(cachedRaw) : [];

  // Migration: if no stored watermark, derive from cached docs' lastSynced.
  const cachedMaxMs = cached.length > 0
    ? cached.reduce((max, d) => Math.max(max, d.lastSynced ? new Date(d.lastSynced).getTime() : 0), 0)
    : 0;
  const effectiveMs = storedLastSyncedMs || cachedMaxMs;

  const now = Date.now();
  const needsFullSync =
    cached.length === 0
    || effectiveMs === 0
    || (lastFullSyncMs > 0 && now - lastFullSyncMs > FULL_SYNC_INTERVAL_MS);

  if (needsFullSync) {
    const full = await fullSyncProgressive(table, mapper, onBatch);
    const newMaxMs = full.reduce(
      (max, d) => Math.max(max, d.lastSynced ? new Date(d.lastSynced).getTime() : 0), 0);
    try {
      await Promise.all([
        AsyncStorage.setItem(cacheKey, JSON.stringify(full)),
        AsyncStorage.setItem(lastSyncedKey, String(newMaxMs)),
        AsyncStorage.setItem(lastFullSyncKey, String(now)),
      ]);
    } catch (e) { /* non-fatal */ }
    return full;
  }

  // Delta sync — fetch docs whose last_synced is past our watermark
  const watermarkISO = new Date(effectiveMs).toISOString();
  const { data, error } = await supabase
    .from(table).select('*')
    .gt('last_synced', watermarkISO)
    .order('last_synced', { ascending: true });
  if (error) {
    console.error(`Delta sync ${table} failed:`, error);
    onBatch(cached);
    return cached;
  }
  if (!data || data.length === 0) {
    onBatch(cached);
    if (!storedLastSyncedMs && effectiveMs > 0) {
      try { await AsyncStorage.setItem(lastSyncedKey, String(effectiveMs)); } catch {}
    }
    return cached;
  }
  const changed = data.map(mapper);
  const merged = mergeAndSort(cached, changed);
  const newMaxMs = changed.reduce(
    (max, d) => Math.max(max, d.lastSynced ? new Date(d.lastSynced).getTime() : 0),
    effectiveMs,
  );
  onBatch(merged);
  try {
    await Promise.all([
      AsyncStorage.setItem(cacheKey, JSON.stringify(merged)),
      AsyncStorage.setItem(lastSyncedKey, String(newMaxMs)),
    ]);
  } catch (e) { /* non-fatal */ }
  return merged;
}

export function loadCustomersProgressive(onBatch) {
  return syncCollection({
    table: 'customers_master', mapper: rowToCustomer,
    cacheKey: CUSTOMERS_CACHE_KEY,
    lastSyncedKey: CUSTOMERS_LAST_SYNCED_KEY,
    lastFullSyncKey: CUSTOMERS_LAST_FULL_SYNC_KEY,
    onBatch,
  });
}
export function loadProductsProgressive(onBatch) {
  return syncCollection({
    table: 'products_master', mapper: rowToProduct,
    cacheKey: PRODUCTS_CACHE_KEY,
    lastSyncedKey: PRODUCTS_LAST_SYNCED_KEY,
    lastFullSyncKey: PRODUCTS_LAST_FULL_SYNC_KEY,
    onBatch,
  });
}

export async function invalidateMasterDataCache() {
  try {
    await Promise.all([
      AsyncStorage.removeItem(CUSTOMERS_CACHE_KEY),
      AsyncStorage.removeItem(PRODUCTS_CACHE_KEY),
      AsyncStorage.removeItem(CUSTOMERS_LAST_SYNCED_KEY),
      AsyncStorage.removeItem(PRODUCTS_LAST_SYNCED_KEY),
      AsyncStorage.removeItem(CUSTOMERS_LAST_FULL_SYNC_KEY),
      AsyncStorage.removeItem(PRODUCTS_LAST_FULL_SYNC_KEY),
    ]);
  } catch (e) { /* ignore */ }
}

export async function getCustomerById(id) {
  const { data } = await supabase.from('customers_master').select('*').eq('id', id).maybeSingle();
  return data ? rowToCustomer(data) : null;
}
export async function getProductById(id) {
  const { data } = await supabase.from('products_master').select('*').eq('id', id).maybeSingle();
  return data ? rowToProduct(data) : null;
}
