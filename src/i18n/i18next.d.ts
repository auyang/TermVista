import { defaultNS, resources } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)["en-US"];
    strictKeyChecks: true;
  }
}
