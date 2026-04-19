declare module 'puppeteer-extra' {
  import type { BrowserLaunchArgumentOptions, LaunchOptions, BrowserConnectOptions } from 'puppeteer';
  const _default: {
    use(plugin: any): typeof _default;
    launch(options?: LaunchOptions & BrowserLaunchArgumentOptions & BrowserConnectOptions): Promise<any>;
  };
  export default _default;
}

declare module 'puppeteer-extra-plugin-stealth' {
  const _default: () => any;
  export default _default;
}
