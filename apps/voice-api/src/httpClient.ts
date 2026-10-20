export type Fetch = typeof globalThis.fetch;

export async function limitedText(response: Response, limit = 65_536): Promise<string> {
  if (!response.body) throw new Error("Missing upstream body");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Upstream body limit exceeded");
      parts.push(value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally { await reader.cancel(); }
}
