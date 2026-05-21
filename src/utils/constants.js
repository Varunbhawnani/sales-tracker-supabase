import { Platform, StatusBar as RNStatusBar } from 'react-native';

/**
 * Color palette — based on user-provided palette:
 * #313647 (Dark Navy) · #435663 (Steel) · #A3B087 (Sage) · #FFF8D4 (Cream)
 */
export const COLORS = {
  // Core palette
  primary: '#313647',
  primaryLight: '#435663',
  primaryDark: '#252A38',
  accent: '#435663',
  background: '#FFF8D4',
  surface: '#FFFFFF',
  card: '#FFFFFF',

  // Status colors (using existing palette tones)
  openQuery: '#B8A04A',
  openQueryBg: '#F5F0D6',
  claimedBySales: '#435663',
  claimedBySalesBg: '#E2E8EC',
  snoozed: '#8C7A5E',
  snoozedBg: '#F0EADE',
  wonPendingAccounts: '#7A9B6D',
  wonPendingAccountsBg: '#E8F0E4',
  pendingVerification: '#6B7FA3',
  pendingVerificationBg: '#E4EAF2',
  verificationFailed: '#A65D5D',
  verificationFailedBg: '#F3E4E4',
  verifiedPendingDispatch: '#5D8A7A',
  verifiedPendingDispatchBg: '#E0EDE8',
  partiallyDispatched: '#8A7B5D',
  partiallyDispatchedBg: '#F0EBDF',
  completed: '#A3B087',
  completedBg: '#EDF1E6',
  lostCancelled: '#A65D5D',
  lostCancelledBg: '#F3E4E4',

  // Legacy status colors (kept for backwards compat with old data)
  pending: '#B8A04A',
  pendingBg: '#F5F0D6',
  claimed: '#435663',
  claimedBg: '#E2E8EC',
  successful: '#A3B087',
  successfulBg: '#EDF1E6',
  unsuccessful: '#A65D5D',
  unsuccessfulBg: '#F3E4E4',

  // Text
  textPrimary: '#313647',
  textSecondary: '#5A6470',
  textTertiary: '#8C9196',
  textInverse: '#FFFFFF',

  // UI
  border: '#E5E2D5',
  divider: '#F0EDDF',
  shadow: 'rgba(49, 54, 71, 0.06)',
  overlay: 'rgba(49, 54, 71, 0.5)',

  // Indicators
  activeGreen: '#A3B087',
  goneQuietRed: '#A65D5D',
  newGray: '#8C9196',

  // Misc
  danger: '#A65D5D',
  warning: '#B8A04A',
  info: '#435663',
  white: '#FFFFFF',
  black: '#000000',
};

// ─── NEW 10-STATE STATUS MACHINE ───
export const STATUS = {
  OPEN_QUERY: 'open_query',
  CLAIMED_BY_SALES: 'claimed_by_sales',
  SNOOZED: 'snoozed',
  WON_PENDING_ACCOUNTS: 'won_pending_accounts',
  PENDING_VERIFICATION: 'pending_verification',
  VERIFICATION_FAILED: 'verification_failed',
  VERIFIED_PENDING_DISPATCH: 'verified_pending_dispatch',
  PARTIALLY_DISPATCHED: 'partially_dispatched',
  COMPLETED: 'completed',
  LOST_CANCELLED: 'lost_cancelled',
};

// Legacy statuses for displaying old query data
export const LEGACY_STATUS = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SUCCESSFUL: 'successful',
  UNSUCCESSFUL: 'unsuccessful',
};

export const STATUS_COLORS = {
  [STATUS.OPEN_QUERY]: { bg: COLORS.openQueryBg, text: COLORS.openQuery },
  [STATUS.CLAIMED_BY_SALES]: { bg: COLORS.claimedBySalesBg, text: COLORS.claimedBySales },
  [STATUS.SNOOZED]: { bg: COLORS.snoozedBg, text: COLORS.snoozed },
  [STATUS.WON_PENDING_ACCOUNTS]: { bg: COLORS.wonPendingAccountsBg, text: COLORS.wonPendingAccounts },
  [STATUS.PENDING_VERIFICATION]: { bg: COLORS.pendingVerificationBg, text: COLORS.pendingVerification },
  [STATUS.VERIFICATION_FAILED]: { bg: COLORS.verificationFailedBg, text: COLORS.verificationFailed },
  [STATUS.VERIFIED_PENDING_DISPATCH]: { bg: COLORS.verifiedPendingDispatchBg, text: COLORS.verifiedPendingDispatch },
  [STATUS.PARTIALLY_DISPATCHED]: { bg: COLORS.partiallyDispatchedBg, text: COLORS.partiallyDispatched },
  [STATUS.COMPLETED]: { bg: COLORS.completedBg, text: COLORS.completed },
  [STATUS.LOST_CANCELLED]: { bg: COLORS.lostCancelledBg, text: COLORS.lostCancelled },
  // Legacy statuses
  [LEGACY_STATUS.PENDING]: { bg: COLORS.pendingBg, text: COLORS.pending },
  [LEGACY_STATUS.CLAIMED]: { bg: COLORS.claimedBg, text: COLORS.claimed },
  [LEGACY_STATUS.SUCCESSFUL]: { bg: COLORS.successfulBg, text: COLORS.successful },
  [LEGACY_STATUS.UNSUCCESSFUL]: { bg: COLORS.unsuccessfulBg, text: COLORS.unsuccessful },
};

export const STATUS_LABELS = {
  [STATUS.OPEN_QUERY]: 'OPEN',
  [STATUS.CLAIMED_BY_SALES]: 'CLAIMED',
  [STATUS.SNOOZED]: 'SNOOZED',
  [STATUS.WON_PENDING_ACCOUNTS]: 'BOOKED',
  [STATUS.PENDING_VERIFICATION]: 'VERIFYING',
  [STATUS.VERIFICATION_FAILED]: 'VERIFY FAILED',
  [STATUS.VERIFIED_PENDING_DISPATCH]: 'READY TO SHIP',
  [STATUS.PARTIALLY_DISPATCHED]: 'PARTIAL',
  [STATUS.COMPLETED]: 'COMPLETED',
  [STATUS.LOST_CANCELLED]: 'LOST',
  // Legacy
  [LEGACY_STATUS.PENDING]: 'PENDING',
  [LEGACY_STATUS.CLAIMED]: 'CLAIMED',
  [LEGACY_STATUS.SUCCESSFUL]: 'SUCCESSFUL',
  [LEGACY_STATUS.UNSUCCESSFUL]: 'UNSUCCESSFUL',
};

/**
 * Valid status transitions — enforced in queryService.
 * Key = current status, Value = array of allowed next statuses.
 */
export const VALID_TRANSITIONS = {
  [STATUS.OPEN_QUERY]: [STATUS.CLAIMED_BY_SALES],
  [STATUS.CLAIMED_BY_SALES]: [STATUS.SNOOZED, STATUS.WON_PENDING_ACCOUNTS, STATUS.LOST_CANCELLED],
  [STATUS.SNOOZED]: [STATUS.CLAIMED_BY_SALES, STATUS.LOST_CANCELLED],
  [STATUS.WON_PENDING_ACCOUNTS]: [STATUS.PENDING_VERIFICATION],
  [STATUS.PENDING_VERIFICATION]: [STATUS.VERIFIED_PENDING_DISPATCH, STATUS.VERIFICATION_FAILED],
  [STATUS.VERIFICATION_FAILED]: [STATUS.PENDING_VERIFICATION, STATUS.WON_PENDING_ACCOUNTS, STATUS.LOST_CANCELLED],
  [STATUS.VERIFIED_PENDING_DISPATCH]: [STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED],
  [STATUS.PARTIALLY_DISPATCHED]: [STATUS.PARTIALLY_DISPATCHED, STATUS.COMPLETED],
  [STATUS.COMPLETED]: [],
  [STATUS.LOST_CANCELLED]: [],
};

// ─── ROLES ───
export const ROLES = {
  OWNER: 'owner',
  SALESPERSON: 'salesperson',
  ACCOUNTS: 'accounts',
  PACKING: 'packing',
  DISPATCH: 'dispatch',
};

export const TIME_PERIODS_LIST = ['this_week', 'this_month', 'this_year', 'all_time'];

export const TIME_PERIODS = {
  ALL_TIME: 'all_time',
  THIS_YEAR: 'this_year',
  THIS_MONTH: 'this_month',
  THIS_WEEK: 'this_week',
};

export const SORT_OPTIONS = {
  MOST_ACTIVE: 'most_active',
  LEAST_ACTIVE: 'least_active',
  MOST_RECENT: 'most_recent',
  GONE_QUIET: 'gone_quiet',
  ALPHABETICAL: 'alphabetical',
};

export const EMAIL_DOMAIN = '@salestracker.app';

export const DEFAULT_GONE_QUIET_DAYS = 30;

// Default SLA thresholds (overridden by settings/app in Firestore)
export const DEFAULT_SLA = {
  escalationDays: 10,     // Sales time-to-win ceiling
  accountsDays: 3,        // Accounts processing SLA
  dispatchDays: 7,        // Dispatch completion SLA
};

/**
 * Safe top padding for screens with headerShown: false.
 * Prevents content from overlapping with the phone's status bar.
 */
export const SAFE_TOP = Platform.OS === 'android'
  ? (RNStatusBar.currentHeight || 0) + 8
  : 0;
