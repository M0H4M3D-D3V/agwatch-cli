declare module 'puppeteer' {
  const _default: {
    executablePath(): string;
    launch(options?: any): Promise<any>;
    [key: string]: any;
  };
  export default _default;
  export function executablePath(): string;
}

declare module 'puppeteer-extra' {
  const _default: {
    use(plugin: any): typeof _default;
    launch(options?: any): Promise<any>;
  };
  export default _default;
}

declare module 'puppeteer-extra-plugin-stealth' {
  const _default: () => any;
  export default _default;
}
