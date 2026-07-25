import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/me`, { withCredentials: true });
      setUser(res.data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const logout = useCallback(async () => {
    try {
      await axios.post(`${API}/api/logout`, {}, { withCredentials: true });
    } catch {
      // Cookie is httpOnly and short-lived either way — clearing local state is enough to boot the user back to the login screen even if this call fails.
    }
    setUser(null);
  }, []);

  const value = {
    user,
    role: user?.role ?? null,
    isAdmin: user?.role === 'admin',
    loading,
    setUser,
    refetch,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
}
