"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  AuthAdapter,
  AuthStateEvent,
  OAuthProvider,
  Session,
  SignInCredentials,
  SignUpCredentials,
  User,
} from "../types";

// =============================================================================
// Auth Context Types
// =============================================================================

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthActions {
  signUp: (
    credentials: SignUpCredentials,
    options?: { onSuccess?: () => void },
  ) => Promise<void>;
  signIn: (
    credentials: SignInCredentials,
    options?: { onSuccess?: () => void },
  ) => Promise<void>;
  signInWithOAuth: (
    provider: OAuthProvider,
    options?: { redirectTo?: string; scopes?: string[] },
  ) => Promise<void>;
  signOut: (options?: { onSuccess?: () => void }) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  updateUser: (
    data: Partial<Pick<User, "name" | "avatarUrl">>,
  ) => Promise<void>;
  refreshSession: () => Promise<void>;
  getProviderToken: (provider: OAuthProvider) => Promise<string | null>;
}

type AuthContextValue = AuthState & AuthActions;

// =============================================================================
// Auth Context
// =============================================================================

const AuthContext = createContext<AuthContextValue | null>(null);

// =============================================================================
// Auth Provider
// =============================================================================

interface AuthProviderProps {
  adapter: AuthAdapter;
  children: ReactNode;
  loadingComponent?: ReactNode;
  onAuthStateChange?: (user: User | null) => void;
}

export function AuthProvider({
  adapter,
  children,
  loadingComponent,
  onAuthStateChange,
}: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  const signOut = useCallback(
    async (options?: { onSuccess?: () => void }) => {
      await adapter.signOut();
      setUser(null);
      setSession(null);
      options?.onSuccess?.();
    },
    [adapter],
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

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      isLoading,
      isAuthenticated: !!user,
      signUp,
      signIn,
      signInWithOAuth,
      signOut,
      resetPassword,
      updatePassword,
      updateUser,
      refreshSession,
      getProviderToken,
    }),
    [
      user,
      session,
      isLoading,
      signUp,
      signIn,
      signInWithOAuth,
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

// =============================================================================
// Hook useAuth
// =============================================================================

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    // During SSR or when auth is not configured, return a loading state
    // This prevents errors during static generation
    if (typeof window === "undefined") {
      return {
        user: null,
        session: null,
        isLoading: true,
        isAuthenticated: false,
        signUp: async () => {
          throw new Error("Auth not initialized");
        },
        signIn: async () => {
          throw new Error("Auth not initialized");
        },
        signInWithOAuth: async () => {
          throw new Error("Auth not initialized");
        },
        signOut: async () => {
          throw new Error("Auth not initialized");
        },
        resetPassword: async () => {
          throw new Error("Auth not initialized");
        },
        updatePassword: async () => {
          throw new Error("Auth not initialized");
        },
        updateUser: async () => {
          throw new Error("Auth not initialized");
        },
        refreshSession: async () => {
          throw new Error("Auth not initialized");
        },
        getProviderToken: async () => {
          console.warn("Auth not initialized");
          return null;
        },
      };
    }

    throw new Error(
      "useAuth must be used within an AuthProvider. Wrap your app in <AuthProvider adapter={...}>.",
    );
  }

  return context;
}

// =============================================================================
// Hook useUser
// =============================================================================

export function useUser(): User | null {
  const { user } = useAuth();
  return user;
}

// =============================================================================
// Hook useSession
// =============================================================================

export function useSession(): Session | null {
  const { session } = useAuth();
  return session;
}
