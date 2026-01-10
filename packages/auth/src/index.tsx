
import {AuthAdapter, AuthAdapterConfig} from "./types";

export function createAuth(config: AuthAdapterConfig): AuthAdapter {
  switch (config.type) {
    case "supabase":
      throw new Error(
        "The Supabase adapter has been moved to its own package: `@terrablox/auth-adapter-supabase`. Please install it and import the adapter directly.",
      );

    case "custom":
      return config.adapter;

    default:
      throw new Error(
        `Unknown auth adapter type: ${(config as { type: string }).type}`,
      );
  }
}
