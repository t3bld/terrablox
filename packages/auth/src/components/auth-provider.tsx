"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthStateEvent,
  OAuthProvider,
  Session,
  SignInCredentials,
  SignUpCredentials,
  User,
  UserIdentity,
} from "../types";

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  adapter,
  children,
  loadingComponent,
  onAuthStateChange,
}: AuthProviderProps): ReactNode {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Serialises overlapping identity loads so a slow stale response cannot
  // overwrite a newer one (e.g. an unauthenticated load resolving after
  // the session became available).
  const identitiesRequestRef = useRef(0);

  const clearIdentities = useCallback(() => {
    identitiesRequestRef.current += 1;
    setIdentities([]);
  }, []);

  const loadIdentities = useCallback(async () => {
    const requestId = ++identitiesRequestRef.current;
    try {
      const next = await adapter.listIdentities();
      if (requestId === identitiesRequestRef.current) {
        setIdentities(next);
      }
    } catch {
      // Linked accounts are supplementary; never block auth on them.
      if (requestId === identitiesRequestRef.current) {
        setIdentities([]);
      }
    }
  }, [adapter]);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    async function initAuth() {
      try {
        const currentSession = await adapter.getSession();

        if (mounted) {
          setSession(currentSession);
          setUser(currentSession?.user ?? null);
          setIsLoading(false);
          onAuthStateChange?.(currentSession?.user ?? null);
        }
      } catch (error) {
        console.error("Failed to initialize auth:", error);
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    initAuth();

    if (adapter.onAuthStateChange) {
      unsubscribe = adapter.onAuthStateChange(
        (_event: AuthStateEvent, newSession: Session | null) => {
          if (mounted) {
            setSession(newSession);
            setUser(newSession?.user ?? null);
            onAuthStateChange?.(newSession?.user ?? null);
          }
        },
      );
    }

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [adapter, onAuthStateChange]);

  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      clearIdentities();
      return;
    }
    loadIdentities();
  }, [userId, loadIdentities, clearIdentities]);

  const signUp = useCallback(
    async (
      credentials: SignUpCredentials,
      options?: { onSuccess?: () => void },
    ) => {
      const result = await adapter.signUp(credentials);
      setUser(result.user);
      setSession(result.session);
      options?.onSuccess?.();
    },
    [adapter],
  );

  const signIn = useCallback(
    async (
      credentials: SignInCredentials,
      options?: { onSuccess?: () => void },
    ) => {
      const result = await adapter.signIn(credentials);
      setUser(result.user);
      setSession(result.session);
      options?.onSuccess?.();
    },
    [adapter],
  );

  const signInWithOAuth = useCallback(
    async (
      provider: OAuthProvider,
      options?: { redirectTo?: string; scopes?: string[] },
    ) => {
      await adapter.signInWithOAuth({
        provider,
        redirectTo: options?.redirectTo,
        scopes: options?.scopes,
      });
    },
    [adapter],
  );

  const linkOAuth = useCallback(
    async (
      provider: OAuthProvider,
      options?: { redirectTo?: string; scopes?: string[] },
    ) => {
      await adapter.linkOAuth({
        provider,
        redirectTo: options?.redirectTo,
        scopes: options?.scopes,
      });
    },
    [adapter],
  );

  const signOut = useCallback(
    async (options?: { onSuccess?: () => void }) => {
      await adapter.signOut();
      setUser(null);
      setSession(null);
      clearIdentities();
      options?.onSuccess?.();
    },
    [adapter, clearIdentities],
  );

  const resetPassword = useCallback(
    async (email: string) => {
      await adapter.resetPassword(email);
    },
    [adapter],
  );

  const updatePassword = useCallback(
    async (newPassword: string) => {
      await adapter.updatePassword(newPassword);
    },
    [adapter],
  );

  const updateUser = useCallback(
    async (data: Partial<Pick<User, "name" | "avatarUrl">>) => {
      const updatedUser = await adapter.updateUser(data);
      setUser(updatedUser);
    },
    [adapter],
  );

  const refreshSession = useCallback(async () => {
    const newSession = await adapter.refreshSession();
    setSession(newSession);
    setUser(newSession?.user ?? null);
  }, [adapter]);

  const getProviderToken = useCallback(
    async (provider: OAuthProvider) => {
      if (adapter.getProviderToken) {
        return adapter.getProviderToken(provider);
      }
      console.warn("getProviderToken is not implemented on the auth adapter.");
      return null;
    },
    [adapter],
  );

  const userWithIdentities = useMemo<User | null>(
    () => (user ? { ...user, identities } : null),
    [user, identities],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userWithIdentities,
      session,
      isLoading,
      isAuthenticated: !!userWithIdentities,
      signUp,
      signIn,
      signInWithOAuth,
      linkOAuth,
      refreshIdentities: loadIdentities,
      signOut,
      resetPassword,
      updatePassword,
      updateUser,
      refreshSession,
      getProviderToken,
    }),
    [
      userWithIdentities,
      session,
      isLoading,
      signUp,
      signIn,
      signInWithOAuth,
      linkOAuth,
      loadIdentities,
      signOut,
      resetPassword,
      updatePassword,
      updateUser,
      refreshSession,
      getProviderToken,
    ],
  );

  if (isLoading && loadingComponent) {
    return <>{loadingComponent}</>;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
