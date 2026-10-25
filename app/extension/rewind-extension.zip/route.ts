// The extension download (/extension/rewind-extension.zip), built from extension/ when the site is built: no request
// data, so the build prerenders it and every visitor gets the same static file (lib/extension-package.ts).

import { EXTENSION_ZIP, extensionZip } from "@/lib/extension-package";

export async function GET() {
  return new Response(new Uint8Array(extensionZip()), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${EXTENSION_ZIP}"` },
  });
}
