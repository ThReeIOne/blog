declare module "twikoo" {
  interface TwikooOptions {
    envId: string;
    el?: HTMLElement | string | null;
    region?: string;
    path?: string;
    lang?: string;
  }
  export function init(options: TwikooOptions): void;
}
