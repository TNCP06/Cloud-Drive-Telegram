// Ambient declaration for mammoth's browser bundle (it ships types only for the
// Node entry point; we import the browser build explicitly in the client).
declare module "mammoth/mammoth.browser.js" {
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer }
  ): Promise<{ value: string; messages: unknown[] }>;
}
