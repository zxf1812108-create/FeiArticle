declare module 'hyphen/en' {
  export interface HyphenateOptions {
    hyphenChar?: string;
    minWordLength?: number;
  }
  export function hyphenateSync(text: string, options?: HyphenateOptions): string;
  const hyphenEn: {
    hyphenateSync: (text: string, options?: HyphenateOptions) => string;
  };
  export default hyphenEn;
}
