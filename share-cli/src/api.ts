/** Thin typed client over the OpenShare worker HTTP API. Every method is
 *  one fetch; errors surface as { status, body } so callers (CLI flags or
 *  TUI panes) decide how to present them. No state beyond the profile
 *  (url + token) it is constructed with. */
export type Profile = { url: string; token: string; root?: boolean; label?: string }
export type ApiResult<T = any> = { status: number; body: T }

export class Api {
  url: string
  token: string
  cookies = new Map<string, string>()

  constructor(p: { url: string; token?: string }) {
    this.url = p.url.replace(/\/+$/, "")
    this.token = p.token ?? ""
  }

  private async req(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<ApiResult> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(extra ?? {}) }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    let res: Response
    try {
      res = await fetch(this.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
    } catch (e: any) {
      return { status: 0, body: { ok: false, error: `network: ${e?.message ?? e}` } }
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^([^=]+)=([^;]*)/.exec(c)
      if (m) this.cookies.set(m[1], m[2])
    }
    let parsed: any = null
    const text = await res.text()
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text.slice(0, 400) } }
    return { status: res.status, body: parsed }
  }

  get(path: string) { return this.req("GET", path) }
  post(path: string, body?: unknown) { return this.req("POST", path, body ?? {}) }
  put(path: string, body?: unknown) { return this.req("PUT", path, body ?? {}) }
  patch(path: string, body?: unknown) { return this.req("PATCH", path, body ?? {}) }
  del(path: string, body?: unknown) { return this.req("DELETE", path, body ?? {}) }

  // ---- public ----
  health() { return this.get("/health") }
  branding() { return this.get("/branding") }

  // ---- identity / self-service ----
  enroll(code: string, label: string) { return this.post("/api/enroll", { code, label }) }
  me() { return this.get("/api/me") }
  meSettings() { return this.get("/api/me/settings") }
  meSettingsPut(settings: Record<string, unknown>) { return this.put("/api/me/settings", { settings }) }
  meShares() { return this.get("/api/me/shares") }
  tokenSelfMint(o: { kind?: string; label?: string; limits?: unknown; sets?: unknown }) { return this.post("/api/token", o) }
  tokenRotate(o: { label?: string; limits?: unknown } = {}) { return this.post("/api/token/rotate", o) }
  tokenUpdate(o: { tokenId?: string; label?: string; limits?: unknown }) { return this.post("/api/token/update", o) }
  tokenSelfDelete() { return this.del("/api/token") }
  tokenSetsGet() { return this.get("/api/token/sets") }
  tokenSetsPut(sets: unknown) { return this.put("/api/token/sets", { sets }) }

  // ---- admin (root) ----
  users() { return this.get("/api/admin/users") }
  userCreate(label: string) { return this.post("/api/admin/users", { label }) }
  userFreeze(id: string) { return this.post(`/api/admin/users/${id}/freeze`) }
  userUnfreeze(id: string) { return this.post(`/api/admin/users/${id}/unfreeze`) }
  userDelete(id: string, mode?: string) { return this.del(`/api/admin/users/${id}`, mode ? { mode } : {}) }
  tokens() { return this.get("/api/admin/tokens") }
  tokenMint(o: { userId: string; label?: string; limits?: unknown; kind?: string; sets?: unknown }) { return this.post("/api/admin/tokens", o) }
  tokenRevoke(id: string) { return this.del(`/api/admin/tokens/${id}`) }
  tokenAdminUpdate(id: string, o: { label?: string; limits?: unknown }) { return this.patch(`/api/admin/tokens/${id}`, o) }
  tokenFreezeShares(id: string) { return this.post(`/api/admin/tokens/${id}/freeze-shares`) }
  codes() { return this.get("/api/admin/codes") }
  codeCreate(o: { label?: string; activations?: number; ttlHours?: number }) { return this.post("/api/admin/codes", o) }
  codeDisable(id: string) { return this.del(`/api/admin/codes/${id}`) }
  codeRevokeLineage(id: string) { return this.post(`/api/admin/codes/${id}/revoke-lineage`) }
  sharesAdmin() { return this.get("/api/admin/shares") }
  shareReassign(id: string, userId: string) { return this.post(`/api/admin/shares/${id}/reassign`, { userId }) }
  purge() { return this.post("/api/admin/purge") }

  // ---- shares ----
  shareData(id: string, since?: number) { return this.get(`/api/share/${id}/data${since !== undefined ? `?since=${since}` : ""}`) }
  shareMeta(id: string) { return this.get(`/api/share/${id}/meta`) }
  shareFreeze(id: string, frozen: boolean) { return this.post(`/api/admin/shares/${id}/${frozen ? "freeze" : "unfreeze"}`) }
  shareDelete(id: string, secret?: string) { return this.del(`/api/share/${id}`, secret ? { secret } : {}) }
  sharePatch(id: string, o: Record<string, unknown>) { return this.patch(`/api/share/${id}`, o) }
  shareAuth(id: string, login: string, password: string) { return this.post(`/api/share/${id}/auth`, { login, password }) }
  shareSnapshot(id: string) { return this.get(`/s/${id}/snapshot?download=1`) }
  headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    return h
  }
}
