/**
 * Time utilities for IST conversion and relative time display.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/**
 * Convert a Firestore Timestamp or Date to IST Date object.
 */
export function toIST(timestamp) {
  if (!timestamp) return null;
  let date;
  if (timestamp.toDate) {
    date = timestamp.toDate();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else {
    date = new Date(timestamp);
  }
  return date;
}

/**
 * Format a timestamp to IST string: dd/mm/yyyy hh:mm IST
 */
export function formatDateIST(timestamp, includeTime = true) {
  const date = toIST(timestamp);
  if (!date || isNaN(date.getTime())) return '';
  
  const options = {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  };
  
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.hour12 = false;
  }
  
  const formatted = date.toLocaleString('en-GB', options);
  return includeTime ? `${formatted} IST` : formatted;
}

/**
 * Format date as dd/mm/yyyy only.
 */
export function formatDateOnly(timestamp) {
  return formatDateIST(timestamp, false);
}

/**
 * Format date as dd-mm-yyyy for filenames.
 */
export function formatDateForFilename(date = new Date()) {
  const d = toIST(date) || new Date();
  const options = {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  };
  const parts = d.toLocaleDateString('en-GB', options).split('/');
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

/**
 * Get relative time string (e.g., "2 hrs ago", "yesterday").
 */
export function relativeTime(timestamp) {
  const date = toIST(timestamp);
  if (!date || isNaN(date.getTime())) return '';
  
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hr${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  
  return formatDateIST(timestamp, false);
}

/**
 * Get start of current week (Monday) at 00:00 local time.
 *
 * Previously this routed through `new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))`,
 * which produces an invalid Date on Hermes (the JS engine React Native uses).
 * The bad date silently broke client-side `<` comparisons before, but now that
 * statsService passes the value to `Timestamp.fromDate`, it surfaces as
 * "RangeError: Date value out of bounds".
 *
 * The business operates in India and users' devices are set to IST, so the
 * device-local Date is already correct — no manual TZ conversion needed.
 */
export function getStartOfWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday is start of week
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get start of current month at 00:00 local time. See getStartOfWeek for context.
 */
export function getStartOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Check if a party has "gone quiet" given lastOrderDate and threshold days.
 */
export function isGoneQuiet(lastOrderDate, thresholdDays) {
  if (!lastOrderDate) return false; // "New" parties are not "gone quiet"
  const date = toIST(lastOrderDate);
  if (!date) return false;
  
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= thresholdDays;
}

/**
 * Get party status string.
 */
export function getPartyStatus(lastOrderDate, totalSetsSold, thresholdDays) {
  if (!lastOrderDate && (!totalSetsSold || totalSetsSold === 0)) return 'new';
  if (isGoneQuiet(lastOrderDate, thresholdDays)) return 'gone_quiet';
  return 'active';
}
