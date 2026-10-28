// Shared base64 → Uint8Array decoder for the embedded Inter subsets
// (kept separate so both workerd and Bun load it without node builtins)
export function decode(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
