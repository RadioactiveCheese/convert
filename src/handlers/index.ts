import type { FormatHandler } from "../FormatHandler.ts";

type HandlerModule = {
  default: new () => FormatHandler;
};

// Keep this list to handlers that resolve cleanly in this environment.
// Missing optional modules should be added back once their dependencies/files are restored.
const handlerModulePaths = [
  "./canvasToBlob.ts",
  "./meyda.ts",
  "./htmlEmbed.ts",
  "./FFmpeg.ts",
  "./pdftoimg.ts",
  "./ImageMagick.ts",
  "./rename.ts",
  "./svgForeignObject.ts",
  "./threejs.ts",
  "./sqlite.ts",
  "./markdown.ts",
  "./vtf.ts",
  "./jszip.ts",
  "./dxf.ts"
] as const;

const handlers: FormatHandler[] = [];

for (const modulePath of handlerModulePaths) {
  try {
    const handlerModule = await import(/* @vite-ignore */ modulePath) as HandlerModule;
    handlers.push(new handlerModule.default());
  } catch (_) {
    // Ignore unavailable handlers so the app can still run with partial support.
  }
}

export default handlers;
