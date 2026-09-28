// A `.md` import is the file's text: esbuild's `loader: { '.md': 'text' }`
// (esbuild.js) in the build, the `md-text` plugin (vitest.config.ts) in tests.
declare module '*.md' {
  const content: string;
  export default content;
}
