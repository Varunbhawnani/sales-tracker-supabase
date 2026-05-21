import React, { createContext, useState, useEffect, useContext, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { ROLES, EMAIL_DOMAIN } from '../utils/constants';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  // Tracks the UID whose users-row we just fetched, so the onAuthStateChange
  // listener can short-circuit and skip a redundant SELECT when login() (or
  // the initial getSession()) has already loaded the same user. Before this
  // ref existed, every login did the users-row fetch twice — once inline in
  // login() for the whitelist check, again inside the listener — which is
  // what made the spinner sit there for an extra round trip.
  const lastLoadedUidRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    // Hard safety timeout: if getSession() hangs (Supabase unreachable,
    // localStorage corrupt, etc.) we give up after 6 seconds and show the
    // login screen instead of leaving the user staring at a spinner forever.
    const hardTimeout = setTimeout(() => {
      if (!cancelled) {
        console.warn('AuthContext: getSession() timed out — falling through to login.');
        setLoading(false);
      }
    }, 6000);

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (cancelled) return;
        if (error) {
          // "Invalid Refresh Token" surfaces here when the stored session is
          // stale (token expired, user deleted, project switched). Clear it
          // explicitly so the next launch starts clean instead of repeating
          // the same failed refresh on every boot.
          if (/refresh token/i.test(error.message || '')) {
            try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
          } else {
            console.error('AuthContext getSession error:', error.message);
          }
        } else if (data?.session) {
          await loadUserDoc(data.session.user.id);
          setSession(data.session);
        }
      } catch (err) {
        if (!cancelled) {
          if (!/refresh token/i.test(err?.message || '')) {
            console.error('AuthContext init failed:', err?.message || err);
          }
          try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
        }
      } finally {
        if (!cancelled) {
          clearTimeout(hardTimeout);
          setLoading(false);
        }
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, s) => {
        if (cancelled) return;
        try {
          if (s) {
            // If login() (or the initial getSession path) already loaded
            // this UID's row, skip the redundant fetch — we already have
            // the userDoc in state.
            if (lastLoadedUidRef.current === s.user.id) {
              setSession(s);
              return;
            }
            await loadUserDoc(s.user.id);
            setSession(s);
          } else {
            lastLoadedUidRef.current = null;
            setSession(null);
            setUserDoc(null);
          }
        } catch (err) {
          console.error('AuthContext onAuthStateChange error:', err?.message || err);
        }
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(hardTimeout);
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadUserDoc = async (userId) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;

      if (!data || data.is_active === false) {
        await supabase.auth.signOut();
        setUserDoc(null);
        lastLoadedUidRef.current = null;
        return null;
      }
      setUserDoc(data);
      lastLoadedUidRef.current = userId;
      return data;
    } catch (err) {
      console.error('Error loading user doc:', err);
      try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
      setUserDoc(null);
      lastLoadedUidRef.current = null;
      return null;
    }
  };

  const login = async (username, password) => {
    const email = username.includes('@') ? username : `${username}${EMAIL_DOMAIN}`;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Single users-row fetch — also covers whitelist + isActive check.
    // We populate userDoc here directly, then the onAuthStateChange listener
    // sees lastLoadedUidRef === this UID and short-circuits.
    const { data: row, error: rowErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) {
      await supabase.auth.signOut();
      throw new Error('Account pending Admin approval. Please contact your administrator.');
    }
    if (row.is_active === false) {
      await supabase.auth.signOut();
      throw new Error('This account has been deactivated. Please contact the administrator.');
    }

    lastLoadedUidRef.current = data.user.id;
    setUserDoc(row);
    setSession(data.session);

    return data;
  };

  const logout = async () => {
    try {
      lastLoadedUidRef.current = null;
      await supabase.auth.signOut();
    } catch (err) {
      console.error('Error logging out:', err);
      throw err;
    }
  };

  const value = {
    user: session?.user || null,
    userDoc,
    userId: userDoc?.id || null,
    userName: userDoc?.name || '',
    userRole: userDoc?.role || null,
    userGodownId: userDoc?.godown_id || null,
    isOwner: userDoc?.role === ROLES.OWNER,
    isSalesperson: userDoc?.role === ROLES.SALESPERSON,
    isAccounts: userDoc?.role === ROLES.ACCOUNTS,
    isOperations: userDoc?.role === ROLES.OPERATIONS,
    isDispatch: userDoc?.role === ROLES.DISPATCH,
    isAuthenticated: !!session && !!userDoc,
    loading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export default AuthContext;
