/// <reference types="vitest/config" />
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js runtime asset directories, served under `/pdfjs/<dir>/`.
 *
 * `wasm` is the load-bearing one: pdf.js decodes JBIG2, CCITTFax and JPX
 * images through WebAssembly modules it fetches at runtime, and CCITT Group 4
 * is the usual compression for scanned monochrome pages. `cmaps` and
 * `standard_fonts` cover CID-keyed encodings and the non-embedded base-14
 * fonts. All three ship inside the installed `pdfjs-dist` package; copying
 * them into our own bundle keeps the app offline — nothing here may ever be
 * pointed at a CDN.
 */
const PDFJS_ASSET_DIRS = ["wasm", "cmaps", "standard_fonts"] as const;

const CONTENT_TYPES: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
};

/**
 * Copy pdf.js's runtime asset directories into the app bundle.
 *
 * Hand-rolled rather than vendored into `public/`: the files then always match
 * the installed `pdfjs-dist` version instead of drifting from it on upgrade,
 * and ~4 MB of binaries stay out of git. Serves the same paths from disk in
 * dev so `bun run dev` and `bun run build` behave identically.
 */
function pdfjsAssets(): Plugin {
    const require = createRequire(import.meta.url);
    const pkgRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

    const entries = () =>
        PDFJS_ASSET_DIRS.flatMap((dir) =>
            fs.readdirSync(path.join(pkgRoot, dir)).map((name) => ({
                source: path.join(pkgRoot, dir, name),
                fileName: `pdfjs/${dir}/${name}`,
            })),
        );

    return {
        name: "pdfjs-assets",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const match = /^\/pdfjs\/([a-z_]+)\/([\w.-]+)$/.exec(
                    (req.url ?? "").split("?")[0]!,
                );
                if (!match || !PDFJS_ASSET_DIRS.includes(match[1] as never)) {
                    return next();
                }
                const name = match[2]!;
                if (name === "." || name === "..") return next();
                const file = path.join(pkgRoot, match[1]!, name);
                if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
                res.setHeader(
                    "Content-Type",
                    CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
                );
                fs.createReadStream(file).on("error", () => res.end()).pipe(res);
            });
        },
        generateBundle() {
            for (const { source, fileName } of entries()) {
                this.emitFile({ type: "asset", fileName, source: fs.readFileSync(source) });
            }
        },
    };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [react(), tailwindcss(), pdfjsAssets()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                  protocol: "ws",
                  host,
                  port: 1421,
              }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },

    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
}));
