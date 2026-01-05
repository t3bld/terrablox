import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  AuthAdapter,
  SignUpCredentials,
  SignInCredentials,
  AuthSession,
  AuthUser,
  OAuthProvider,
} from "./base";

export class SupabaseAuthAdapter extends AuthAdapter {
  private client: SupabaseClient;

  constructor() {
    super();

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Supabase credentials not found. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY"
      );
    }

    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async signUp(credentials: SignUpCredentials): Promise<AuthSession> {
    const { data, error } = await this.client.auth.signUp({
      email: credentials.email,
      password: credentials.password,
      options: {
        data: {
          name: credentials.name,
        },
      },
    });

    if (error) throw error;
    if (!data.session) throw new Error("No session returned");

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata.name,
        avatar_url: data.user.user_metadata.avatar_url,
      },
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    };
  }

  async signIn(credentials: SignInCredentials): Promise<AuthSession> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    });

    if (error) throw error;
    if (!data.session) throw new Error("No session returned");

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata.name,
        avatar_url: data.user.user_metadata.avatar_url,
      },
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    };
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async getUser(): Promise<AuthUser | null> {
    const {
      data: { user },
    } = await this.client.auth.getUser();

    if (!user) return null;

    return {
      id: user.id,
      email: user.email!,
      name: user.user_metadata.name,
      avatar_url: user.user_metadata.avatar_url,
    };
  }

  async getSession(): Promise<AuthSession | null> {
    const {
      data: { session },
    } = await this.client.auth.getSession();

    if (!session) return null;

    return {
      user: {
        id: session.user.id,
        email: session.user.email!,
        name: session.user.user_metadata.name,
        avatar_url: session.user.user_metadata.avatar_url,
      },
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    };
  }

  async signInWithOAuth(params: OAuthProvider): Promise<void> {
    const { error } = await this.client.auth.signInWithOAuth({
      provider: params.provider,
      options: {
        redirectTo: params.redirectTo,
      },
    });

    if (error) throw error;
  }

  async resetPassword(email: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email);
    if (error) throw error;
  }

  async updatePassword(newPassword: string): Promise<void> {
    const { error } = await this.client.auth.updateUser({
      password: newPassword,
    });
    if (error) throw error;
  }
}

