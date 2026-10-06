import baseConfig from "@terrablox/ui/tailwind.config";
import type { Config } from "tailwindcss";

const config: Config = {
  // The preset carries every colour, radius and animation token. Extending the
  // theme here would fork the design from the dashboard, which is the one thing
  // a shared library exists to prevent — put new tokens in the preset instead.
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    // The architecture diagram in the demo — its classes live in the package, and
    // without this the boxes render unstyled.
    "../../packages/graph/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  presets: [baseConfig],
};

export default config;
