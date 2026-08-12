# @terrablox/auth

Flexible authentication package with an adapter pattern for easy customization to provide your own implementation.

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Creating a Custom Adapter](#creating-a-custom-adapter)

## Features

- **Adapter Pattern:** Swap authentication providers and easily implement new auth integrations
- **Better Auth Integration:** Default adapter backed by a self-hosted [Better Auth](https://better-auth.com) instance
- **React Hooks:** Easy-to-use hooks for client-side auth
- **Server Utilities:** Protect API routes and server components

## Installation

```bash
pnpm add @terrablox/auth
```

## Quick Start

### 1. Add auth provider to the app

```tsx
"use client";

import { BetterAuthAdapter } from "@terrablox/auth/adapters/better-auth";
import { AuthProvider } from "@terrablox/auth";
import { useMemo } from "react";

export function Providers({ children }) {
    const auth = useMemo(() => {
        return new BetterAuthAdapter({
            // Defaults to the current origin when omitted.
            baseURL: process.env.NEXT_PUBLIC_APP_URL,
        });
    }, []);

    return <AuthProvider adapter={auth}>{children}</AuthProvider>;
}
```

The adapter talks to the Better Auth route handler mounted at
`/api/auth/[...all]` in the dashboard app.

### 2. Use auth in components

```tsx
"use client";

import { useAuth } from "@terrablox/auth/hooks";

export function AuthButton() {
  const { user, signIn, signOut, isLoading } = useAuth();

  if (isLoading) {
    return <button disabled>Loading...</button>;
  }

  if (user) {
    return (
      <div>
        <span>Hello, {user.name ?? user.email}</span>
        <button onClick={() => signOut()}>Sign Out</button>
      </div>
    );
  }

  return (
    <button onClick={() => signIn({ email: "user@example.com", password: "password" })}>
      Sign In
    </button>
  );
}
```

## Creating a Custom Adapter

Implement the `AuthAdapter` abstract class to create your own adapter.

```typescript
import { AuthAdapter, AuthResult, Session, User } from "@terrablox/auth";

export class MyCustomAdapter extends AuthAdapter {
  async signUp(credentials: SignUpCredentials): Promise<AuthResult> {
    // Your implementation
  }

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    // Your implementation
  }

  async signInWithOAuth(options: OAuthSignInOptions): Promise<void> {
    // Your implementation
  }

  async signOut(): Promise<void> {
    // Your implementation
  }

  async getSession(): Promise<Session | null> {
    // Your implementation
  }

  async refreshSession(): Promise<Session | null> {
    // Your implementation
  }

  async getUser(): Promise<User | null> {
    // Your implementation
  }

  async updateUser(data: Partial<User>): Promise<User> {
    // Your implementation
  }

  async resetPassword(email: string): Promise<void> {
    // Your implementation
  }

  async updatePassword(newPassword: string): Promise<void> {
    // Your implementation
  }

  async getProviderToken(provider: string): Promise<string | null> {
    // Your implementation
  }

  onAuthStateChange(callback: (event: AuthStateEvent, session: Session | null) => void): () => void {
    // Your implementation
  }
}
```