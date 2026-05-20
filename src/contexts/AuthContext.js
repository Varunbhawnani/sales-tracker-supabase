import React, { createContext, useState, useEffect, useContext } from 'react';
import { supabase } from '../lib/supabase';
import { ROLES, EMAIL_DOMAIN } from '../utils/constants';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Hard safety timeout: if getSession() hangs (Supabase unreachable,
    // localStorage corrupt, etc.) we give up after 10 seconds and show the
    // login screen instead of leaving the user staring at a spinner forever.
    const hardTimeout = setTimeout(() => {
      if (!cancelled) {
        console.warn('AuthContext: getSession() timed out after 10s — falling through to login.');
        setLoading(false);
      }
    }, 10000);

    // 1. Load any existing session (from AsyncStorage / localStorage)
    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (cancelled) return;
        if (error) {
          console.error('AuthContext getSession error:', error.message);
        } else if (data?.session) {
          await loadUserDoc(data.session.user.id);
          setSession(data.session);
        }
      } catch (err) {
        if (!cancelled) console.error('AuthContext init failed:', err?.message || err);
      } finally {
        if (!cancelled) {
          clearTimeout(hardTimeout);
          setLoading(false);
        }
      }
    })();

    // 2. Subscribe to auth state changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, s) => {
        if (cancelled) return;
        try {
          if (s) {
            await loadUserDoc(s.user.id);
            setSession(s);
          } else {
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

  /**
   * Load the public.users row for the current auth user. Sign out cleanly
   * if no row exists (whitelist check) or the user is deactivated.
   */
  const loadUserDoc = async (userId) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        // No matching row in public.users — auth user exists but not whitelisted
        await supabase.auth.signOut();
        setUserDoc(null);
        return;
      }
      if (data.is_active === false) {
        await supabase.auth.signOut();
        setUserDoc(null);
        return;
      }
      setUserDoc(data);
    } catch (err) {
      console.error('Error loading user doc:', err);
      // Sign out cleanly so the app shows the login screen, not a half-authed state
      try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
      setUserDoc(null);
    }
  };

  const login = async (username, password) => {
    // Same convention as the Firebase version: usernames map to synthetic emails
    const email = username.includes('@') ? username : `${username}${EMAIL_DOMAIN}`;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Whitelist + isActive check
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

    return data;
  };

  const logout = async () => {
    try {
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
    isOwner: userDoc?.role === ROLES.OWNER,
    isSalesperson: userDoc?.role === ROLES.SALESPERSON,
    isAccounts: userDoc?.role === ROLES.ACCOUNTS,
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
