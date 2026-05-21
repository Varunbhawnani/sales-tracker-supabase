import React, {
  createContext, useContext, useEffect, useState, useCallback, useMemo, useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { subscribeToUsers } from '../services/authService';
import { ROLES } from '../utils/constants';
import { subscribeToGodowns } from '../services/godownService';

// Filter sentinels stored in state. A real godown UUID is anything else.
export const FILTER_ALL = '__all__';
export const FILTER_UNASSIGNED = '__unassigned__';

const STORAGE_KEY = 'godownFilterId:v1';

const GodownFilterContext = createContext({});

/**
 * Owner-only global filter for "which godown am I looking at right now?"
 *
 * Behaviour:
 *   - Non-owners: filterId stays FILTER_ALL, filter helpers are no-ops. The
 *     hook can be called from any screen without conditionals.
 *   - Owner: filterId is loaded from AsyncStorage on mount, persisted on
 *     every change. The provider subscribes to users (and godowns) once and
 *     shares them with every consumer — screens don't each pay for their own
 *     listener.
 *   - `filterQueries(queries)` keeps only queries whose creator OR claimer is
 *     a user in the selected godown. FILTER_UNASSIGNED matches users without
 *     a godown_id.
 */
export function GodownFilterProvider({ children }) {
  const { userRole, isAuthenticated, userGodownId } = useAuth();
  const isOwner = userRole === ROLES.OWNER;

  const [filterId, setFilterIdState] = useState(FILTER_ALL);
  const [users, setUsers] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const loadedRef = useRef(false);

  // Load persisted filter on first mount of an owner session. We only persist
  // for owners — non-owner users shouldn't have any state in this key.
  useEffect(() => {
    if (!isOwner || loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) setFilterIdState(saved);
      } catch (e) { /* ignore */ }
    })();
  }, [isOwner]);

  // Reset on logout so a different owner doesn't inherit the previous one's
  // filter, and so storage doesn't sit half-stale.
  useEffect(() => {
    if (!isAuthenticated) {
      setFilterIdState(FILTER_ALL);
      loadedRef.current = false;
      AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    }
  }, [isAuthenticated]);

  // Owner-only subscriptions — non-owners don't need this data and we'd
  // rather not pay for the listener. Realtime keeps the userId → godownId
  // map fresh as admin reassigns people.
  useEffect(() => {
    if (!isOwner) {
      setUsers([]);
      setGodowns([]);
      return undefined;
    }
    const unsubU = subscribeToUsers((list) => setUsers(list));
    const unsubG = subscribeToGodowns((list) => setGodowns(list), { includeInactive: true });
    return () => { unsubU(); unsubG(); };
  }, [isOwner]);

  const setFilterId = useCallback((id) => {
    setFilterIdState(id);
    if (isOwner) {
      AsyncStorage.setItem(STORAGE_KEY, id || FILTER_ALL).catch(() => {});
    }
  }, [isOwner]);

  // Build a Set of user IDs that "belong" to the current filter. When the
  // filter is ALL, every user belongs (and the helpers below short-circuit
  // before they look at this set). When the filter is UNASSIGNED, the set
  // is everyone with godown_id == null. Otherwise it's everyone with the
  // matching godown_id.
  const matchingUserIds = useMemo(() => {
    if (!isOwner || filterId === FILTER_ALL) return null; // null sentinel = no filtering
    if (filterId === FILTER_UNASSIGNED) {
      return new Set(users.filter((u) => !u.godownId).map((u) => u.id));
    }
    return new Set(users.filter((u) => u.godownId === filterId).map((u) => u.id));
  }, [isOwner, filterId, users]);

  const userInGodown = useCallback((userId) => {
    if (matchingUserIds === null) return true;
    return matchingUserIds.has(userId);
  }, [matchingUserIds]);

  // Two filtering regimes share this function:
  //
  //   Non-owner role:
  //     - If the user has no godown assigned (or owner is querying via this
  //       hook on a non-owner screen they're impersonating), all queries
  //       pass through.
  //     - If assigned: only queries where q.godownId IS NULL or matches the
  //       user's own godown_id. NULL means "visible to everyone" (matches
  //       the rule chosen for pre-019 legacy queries + queries created with
  //       no godown picker selection).
  //
  //   Owner with the global chip:
  //     - FILTER_ALL: everything visible.
  //     - FILTER_UNASSIGNED: only q.godownId IS NULL (no godown attached).
  //     - Specific godown id: only q.godownId === filterId.
  //
  // Stats screens (Leaderboard, MyStats) do NOT call filterQueries — that's
  // intentional, by user request stats stay "all together" across godowns.
  const filterQueries = useCallback((queries) => {
    const arr = queries || [];
    if (!isOwner) {
      if (!userGodownId) return arr;
      return arr.filter((q) => !q.godownId || q.godownId === userGodownId);
    }
    // Owner branch — chip-driven.
    if (filterId === FILTER_ALL) return arr;
    if (filterId === FILTER_UNASSIGNED) return arr.filter((q) => !q.godownId);
    return arr.filter((q) => q.godownId === filterId);
  }, [isOwner, userGodownId, filterId]);

  const filterUsers = useCallback((list) => {
    if (matchingUserIds === null) return list;
    return (list || []).filter((u) => matchingUserIds.has(u.id));
  }, [matchingUserIds]);

  // Convenience: filter rows that carry a userId field directly (e.g.
  // leaderboard entries).
  const filterByUserId = useCallback((rows, key = 'userId') => {
    if (matchingUserIds === null) return rows;
    return (rows || []).filter((r) => {
      const uid = r?.[key] || r?.id;
      return uid && matchingUserIds.has(uid);
    });
  }, [matchingUserIds]);

  const value = useMemo(() => ({
    filterId,
    setFilterId,
    isAll: filterId === FILTER_ALL,
    isUnassigned: filterId === FILTER_UNASSIGNED,
    isOwner,
    godowns,
    users,
    matchingUserIds,
    userInGodown,
    filterQueries,
    filterUsers,
    filterByUserId,
  }), [filterId, setFilterId, isOwner, godowns, users, matchingUserIds, userInGodown, filterQueries, filterUsers, filterByUserId]);

  return (
    <GodownFilterContext.Provider value={value}>
      {children}
    </GodownFilterContext.Provider>
  );
}

export function useGodownFilter() {
  const ctx = useContext(GodownFilterContext);
  if (!ctx) {
    // Allow components to call the hook even outside the provider (e.g. on
    // the login screen). Return a no-op shape so the call sites don't need
    // to special-case unauthenticated state.
    return {
      filterId: FILTER_ALL,
      setFilterId: () => {},
      isAll: true,
      isUnassigned: false,
      isOwner: false,
      godowns: [],
      users: [],
      matchingUserIds: null,
      userInGodown: () => true,
      filterQueries: (q) => q,
      filterUsers: (u) => u,
      filterByUserId: (r) => r,
    };
  }
  return ctx;
}
