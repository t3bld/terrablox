"use client";

import { useContext } from "react";
import { AuthContext } from "../components/auth-provider";
import { AuthContextValue, Session, User } from "../types";

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

export function useUser(): User | null {
  const { user } = useAuth();
  return user;
}

export function useSession(): Session | null {
  const { session } = useAuth();
  return session;
}
