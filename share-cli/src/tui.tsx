/** Interactive console: every mutation here has a headless twin in
 *  cli.tsx. One tab bar, list panes with sort cycling, detail panes under
 *  the selection, modals for input and confirmation. */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Text, render, useApp, useInput } from "ink"
import { Api } from "./api"
import * as cfg from "./config"

const dim = (s: string) => <Text color="gray">{s}</Text>
const fmtDate = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-")
const rel = (ms?: number): string => {
  if (!ms) return "never"
  const s = Math.max(0, Date.now() - ms) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const relFuture = (ms?: number): string => {
  if (!ms) return "-"
  const s = (ms - Date.now()) / 1000
  if (s <= 0) return "EXPIRED"
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`
  if (s < 86400) return `in ${Math.ceil(s / 3600)}h`
  return `in ${Math.ceil(s / 86400)}d`
}
function StatusText(props: { status?: string | null; frozen?: boolean; children?: React.ReactNode }) {
  const s = props.status ?? "?"
  const color = props.frozen ? "red" : s === "live" ? "green" : s === "completed" ? "cyan" : s === "error" ? "red" : s === "interrupted" ? "yellow" : "gray"
  return <Text color={color} bold>{s}{props.frozen ? "/FROZEN" : ""}</Text>
}

// ---- small primitives --------------------------------------------------------

function TextInput(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; focus?: boolean; placeholder?: string; password?: boolean }) {
  const [focused, setFocused] = useState(true)
  useInput((ch, key) => {
    if (props.focus === false) return
    if (key.return) { props.onSubmit(); return }
    if (key.escape) return
    if (key.backspace || key.delete) { props.onChange(props.value.slice(0, -1)); return }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || key.ctrl || key.meta) return
    if (ch) props.onChange(props.value + ch)
  }, { isActive: focused && props.focus !== false })
  useEffect(() => { setFocused(props.focus !== false) }, [props.focus])
  const shown = props.password ? "*".repeat(props.value.length) : props.value
  return <Text color="cyan">{shown || <Text color="gray">{props.placeholder ?? ""}</Text>}</Text>
}

function Confirm(props: { text: string; onYes: () => void; onNo: () => void }) {
  useInput((ch, key) => {
    if (ch === "y" || key.return) props.onYes()
    else if (ch === "n" || key.escape) props.onNo()
  })
  return (
    <Box borderStyle="round" borderColor="red" paddingX={2} paddingY={1} flexDirection="column">
      <Text color="red" bold>{props.text}</Text>
      <Text>  <Text bold>y</Text> confirm   <Text bold>n</Text>/<Text bold>esc</Text> cancel</Text>
    </Box>
  )
}

type FormField = { name: string; label: string; initial?: string; password?: boolean; optional?: boolean; numeric?: boolean; placeholder?: string }
function Form(props: { title: string; fields: FormField[]; onSubmit: (vals: Record<string, string>) => void; onCancel: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((f) => [f.name, f.initial ?? ""])))
  const [i, setI] = useState(0)
  const [err, setErr] = useState("")
  useInput((ch, key) => {
    if (key.escape) { props.onCancel(); return }
    if (key.upArrow) { setI((v) => Math.max(0, v - 1)); return }
    if (key.downArrow || key.tab) { setI((v) => Math.min(props.fields.length - 1, v + 1)); return }
    if (key.return) {
      const f = props.fields[i]
      if (f.numeric && vals[f.name] && !/^\d+$/.test(vals[f.name])) { setErr(`${f.label}: digits only`); return }
      if (i < props.fields.length - 1) { setI(i + 1); return }
      for (const fl of props.fields) {
        if (!fl.optional && !vals[fl.name]) { setErr(`${fl.label} required`); return }
      }
      props.onSubmit(vals)
    }
  })
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
      <Text bold>{props.title}</Text>
      {props.fields.map((f, idx) => (
        <Box key={f.name} gap={1}>
          <Text color={idx === i ? "cyan" : "gray"}>{(idx === i ? "> " : "  ") + f.label + ":"}</Text>
          {idx === i
            ? <TextInput value={vals[f.name]} onChange={(v) => { setVals({ ...vals, [f.name]: v }); setErr("") }} onSubmit={() => { }} />
            : <Text>{f.password ? "*".repeat(vals[f.name].length) : vals[f.name]}</Text>}
          {f.optional && idx === i ? dim(" (optional)") : null}
        </Box>
      ))}
      {err ? <Text color="red">{err}</Text> : null}
      {dim("enter next/submit · tab/down next · up prev · esc cancel")}
    </Box>
  )
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; err: string; reload: () => void; set: (t: T) => void } {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState("")
  const [n, setN] = useState(0)
  useEffect(() => { let alive = true; fn().then((d) => { if (alive) { setData(d); setErr("") } }).catch((e) => alive && setErr(e?.message ?? String(e))); return () => { alive = false } }, [...deps, n])
  return { data, err, reload: () => setN(n + 1), set: setData }
}

/** Sort cycler: s cycles the given keys, default = first entry. */
function useSort(keys: string[]): { key: string; label: string; cycle: () => void } {
  const [i, setI] = useState(0)
  const cycle = useCallback(() => setI((v) => (v + 1) % (keys.length * 2)), [keys.length])
  const idx = Math.floor(i / 2)
  const desc = i % 2 === 0
  return { key: keys[idx], label: `${keys[idx]}${desc ? "↓" : "↑"}`, cycle }
}
function sortWith<T>(rows: T[], key: string, desc: boolean, keyOf: (r: T, key: string) => string | number | undefined): T[] {
  const dir = desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const ka = keyOf(a, key); const kb = keyOf(b, key)
    if (ka === kb) return 0
    if (ka === undefined || ka === null) return 1
    if (kb === undefined || kb === null) return -1
    return ka > kb ? dir : -dir
  })
}

// ---- app ---------------------------------------------------------------------

type Screen = "servers" | "shares" | "users" | "tokens" | "codes" | "settings"
const SCREENS: Screen[] = ["servers", "shares", "users", "tokens", "codes", "settings"]

function App() {
  const { exit } = useApp()
  const [conf, setConf] = useState(() => cfg.load())
  const cur = cfg.current(conf)
  const [screen, setScreen] = useState<Screen>("servers")
  const [toast, setToast] = useState("")
  const api = useMemo(() => new Api(cur ? { url: cur.entry.url, token: cur.entry.token } : { url: "" }), [cur?.entry.url, cur?.entry.token])
  const health = useAsync(async () => (cur ? await api.health() : null), [cur?.entry.url])
  const me = useAsync(async () => (cur && cur.entry.token ? await api.me() : null), [cur?.entry.url, cur?.entry.token])

  const say = useCallback((m: string) => { setToast(m) }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t) }, [toast])

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") { exit(); return }
    if (!cur && screen !== "servers") { setScreen("servers"); return }
    if (key.leftArrow || key.rightArrow) {
      const i = SCREENS.indexOf(screen)
      setScreen(SCREENS[(i + (key.rightArrow ? 1 : SCREENS.length - 1)) % SCREENS.length])
    }
  })

  if (!cur || screen === "servers") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ServersScreen conf={conf} setConf={setConf} onPicked={() => { setScreen("shares"); health.reload(); me.reload() }} say={say} />
        <StatusLine conf={conf} health={health.data?.body} me={me.data?.body} />
        <Toast toast={toast} />
      </Box>
    )
  }

  const role = me.data?.body?.ok ? `${me.data.body.label ?? me.data.body.userId} · ${me.data.body.token?.kind} token` : (cur.entry.kind === "root" ? "ROOT" : "anonymous")

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1} marginBottom={0}>
        <Text bold color="green">osh</Text>
        <Text bold>{cur.name}</Text>
        {dim(cur.entry.url)}
        {health.data?.body ? dim(` v${String(health.data.body.version ?? "").split(" · ")[0]}`) : null}
        <Text color="yellow"> [{role}]</Text>
      </Box>
      <Box gap={1}>
        {SCREENS.map((s) => (
          <Text key={s} color={s === screen ? "cyan" : "gray"} bold={s === screen}>{(s === screen ? "[" : " ") + s + (s === screen ? "]" : " ")}</Text>
        ))}
      </Box>
      {screen === "shares" && <SharesScreen api={api} conf={conf} say={say} />}
      {screen === "users" && <UsersScreen api={api} say={say} />}
      {screen === "tokens" && <TokensScreen api={api} conf={conf} setConf={setConf} say={say} />}
      {screen === "codes" && <CodesScreen api={api} say={say} />}
      {screen === "settings" && <SettingsScreen api={api} kind={cur.entry.kind} say={say} />}
      <StatusLine conf={conf} health={health.data?.body} me={me.data?.body} />
      <Toast toast={toast} />
    </Box>
  )
}

function StatusLine(props: { conf: cfg.CliConfig; health: any; me: any }) {
  return (
    <Box marginTop={1}>
      {dim(`←→ tabs · s sort · r reload · q quit`)}
      {props.health ? dim(` · auth ${props.health.auth?.mode ?? "?"}`) : null}
      {props.me?.ok ? dim(` · ${props.me.userId}`) : null}
    </Box>
  )
}

function Toast(props: { toast: string }) {
  if (!props.toast) return null
  return <Box><Text color="green" bold>{props.toast}</Text></Box>
}

// ---- servers -----------------------------------------------------------------

function ServersScreen(props: { conf: cfg.CliConfig; setConf: (c: cfg.CliConfig) => void; onPicked: () => void; say: (m: string) => void }) {
  const names = Object.keys(props.conf.servers)
  const [sel, setSel] = useState(0)
  const [mode, setMode] = useState<"list" | "add">("list")
  useInput((ch, key) => {
    if (mode !== "list") return
    if (key.upArrow) setSel((v) => Math.max(0, v - 1))
    else if (key.downArrow) setSel((v) => Math.min(names.length - 1, v + 1))
    else if (ch === "a") setMode("add")
    else if (key.return && names.length) {
      const c = { ...props.conf, current: names[sel] }
      props.setConf(c); cfg.save(c); props.onPicked()
    } else if ((ch === "x" || ch === "d") && names.length) {
      const c = { ...props.conf, servers: { ...props.conf.servers } }
      delete c.servers[names[sel]]
      if (c.current === names[sel]) c.current = Object.keys(c.servers)[0]
      props.setConf(c); cfg.save(c); setSel(0); props.say(`removed ${names[sel]}`)
    }
  })
  if (mode === "add") {
    return <AddServer conf={props.conf} setConf={props.setConf} onDone={(n) => { setMode("list"); if (n) props.onPicked() }} say={props.say} />
  }
  return (
    <Box flexDirection="column">
      <Text bold>servers</Text>
      {names.length === 0 && <Text color="yellow">none configured - press <Text bold>a</Text> to add one (url + token / access code)</Text>}
      {names.map((n, i) => {
        const e = props.conf.servers[n]
        return (
          <Box key={n} gap={1}>
            <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + n}</Text>
            {dim(e.url)}
            {e.kind ? <Text color="magenta">[{e.kind}]</Text> : null}
            {props.conf.current === n ? <Text color="green">(active)</Text> : null}
          </Box>
        )
      })}
      {names.length ? dim("enter use · x remove") : null}
      {dim("a add server · q quit")}
    </Box>
  )
}

function AddServer(props: { conf: cfg.CliConfig; setConf: (c: cfg.CliConfig) => void; onDone: (name?: string) => void; say: (m: string) => void }) {
  const [stage, setStage] = useState<"url" | "method" | "token" | "code">("url")
  const [url, setUrl] = useState("")
  const [err, setErr] = useState("")
  const api = useMemo(() => new Api({ url, token: "" }), [url])

  const save = async (token: string, kind: string, name: string) => {
    const c = { ...props.conf, servers: { ...props.conf.servers, [name]: { url, token, kind } }, current: name }
    props.setConf(c); cfg.save(c)
    props.say(`saved ${name} (${kind})`)
    props.onDone(name)
  }

  return (
    <Box flexDirection="column">
      {stage === "url" && (
        <Form
          title="connect to a worker"
          fields={[{ name: "url", label: "worker url", placeholder: "https://openshare-worker.<account>.workers.dev" }]}
          onCancel={() => props.onDone()}
          onSubmit={async (v) => {
            const h = await new Api({ url: v.url }).health()
            if (h.status === 0 || h.status >= 400) { setErr(`cannot reach ${v.url} (${h.status})`); return }
            setUrl(v.url.replace(/\/+$/, "")); setStage("method")
          }}
        />
      )}
      {stage === "method" && (
        <Box flexDirection="column">
          <Text bold>{url}</Text>
          <Text>  <Text bold color="cyan">1</Text> paste a token (user osk_ or root)</Text>
          <Text>  <Text bold color="cyan">2</Text> enroll with an access code (osc_)</Text>
          <Text>  <Text bold color="cyan">3</Text> anonymous (view-only)</Text>
          {err ? <Text color="red">{err}</Text> : null}
          {dim("esc back")}
          <MethodPicker onPick={async (m) => {
            if (m === "3") await save("", "anon", url.replace(/^https?:\/\//, "").split(/[./]/)[0])
            else setStage(m === "1" ? "token" : "code")
          }} onBack={() => setStage("url")} />
        </Box>
      )}
      {stage === "token" && (
        <Form
          title="paste token"
          fields={[{ name: "token", label: "token", password: true }, { name: "label", label: "server name", optional: true }]}
          onCancel={() => setStage("method")}
          onSubmit={async (v) => {
            const a = new Api({ url, token: v.token })
            const meR = await a.me()
            const kind = meR.body?.ok ? meR.body.token?.kind ?? "full" : "root"
            if (!meR.body?.ok && meR.status >= 400 && meR.status !== 401) { setErr(`token check failed (${meR.status})`); return }
            await save(v.token, kind, v.label || url.replace(/^https?:\/\//, "").split(/[./]/)[0])
          }}
        />
      )}
      {stage === "code" && (
        <Form
          title="enroll (creates your user + first token)"
          fields={[{ name: "code", label: "access code", password: true }, { name: "label", label: "your label" }, { name: "name", label: "server name", optional: true }]}
          onCancel={() => setStage("method")}
          onSubmit={async (v) => {
            const r = await api.enroll(v.code, v.label)
            if (!r.body?.ok) { setErr(`enroll failed: ${r.body?.error ?? r.status}`); return }
            await save(r.body.token, r.body.tokenKind ?? "full", v.name || url.replace(/^https?:\/\//, "").split(/[./]/)[0])
          }}
        />
      )}
    </Box>
  )
}

function MethodPicker(props: { onPick: (m: "1" | "2" | "3") => void; onBack: () => void }) {
  useInput((ch, key) => {
    if (key.escape) props.onBack()
    else if (ch === "1" || ch === "2" || ch === "3") props.onPick(ch)
  })
  return null
}

// ---- list helper ---------------------------------------------------------------

function useList(len: number): [number, (fn: (v: number) => number) => void] {
  const [sel, setSel] = useState(0)
  useEffect(() => { if (sel >= len) setSel(Math.max(0, len - 1)) }, [len])
  return [sel, setSel]
}
const listKeys = (ch: string, key: any, sel: number, len: number, setSel: (fn: (v: number) => number) => void): boolean => {
  if (key.upArrow) { setSel((v) => Math.max(0, v - 1)); return true }
  if (key.downArrow) { setSel((v) => Math.min(len - 1, v + 1)); return true }
  return false
}

// ---- shares -------------------------------------------------------------------

type ShareListRow = {
  id: string; sessionID?: string; ownerId?: string | null; createdAt?: number; custom?: Record<string, unknown>
  meta?: { status?: string; rev?: number; frozen?: boolean; gated?: boolean; title?: string; subagents?: number; expiresAt?: number; pluginSeen?: number; lastViewerAt?: number; viewerSessions?: number; sessions?: Array<{ id: string; title: string; agent: string; subagent: boolean; parentID: string | null; model?: string }> } | null
}

function SharesScreen(props: { api: Api; conf: cfg.CliConfig; say: (m: string) => void }) {
  const [detail, setDetail] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ id: string } | null>(null)
  const sort = useSort(["created", "title", "status", "owner"])
  const list = useAsync(async () => {
    const admin = await props.api.sharesAdmin()
    let rows: Array<{ id: string; sessionID?: string; ownerId?: string | null; createdAt?: number; custom?: Record<string, unknown> }> = []
    let scope = "denied" as "all" | "own" | "denied"
    if (admin.status === 200 && admin.body?.ok) { rows = admin.body.shares ?? []; scope = "all" }
    else {
      const mine = await props.api.meShares()
      if (mine.body?.ok) { rows = (mine.body.shares ?? []).map((s: any) => ({ id: s.id, sessionID: s.sessionID, ownerId: null, createdAt: s.createdAt })); scope = "own" }
    }
    // owner label join + bounded meta hydration
    const owners = new Map<string, string>()
    if (scope === "all") {
      const users = await props.api.users()
      if (users.status === 200 && users.body?.ok) for (const u of users.body.users ?? []) owners.set(u.id, u.label)
    }
    const metas = new Map<string, any>()
    const ids = rows.slice(0, 100).map((r) => r.id)
    const queue = [...ids]
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const id = queue.shift()
        if (!id) return
        try {
          const r = await props.api.shareMeta(id)
          if (r.status === 200 && r.body?.ok) {
            const sessions = Object.entries(r.body.summaries ?? {}).map(([sid, s]: [string, any]) => ({ id: sid, title: s.title, agent: s.agent, subagent: !!s.parentID, parentID: s.parentID, model: s.model }))
            metas.set(id, {
              status: r.body.status, rev: r.body.rev, frozen: !!r.body.frozen, gated: !!r.body.auth?.set,
              title: sessions.find((s) => !s.subagent)?.title ?? "",
              subagents: sessions.filter((s) => s.subagent).length,
              expiresAt: r.body.expiresAt, pluginSeen: r.body.pluginSeen, lastViewerAt: r.body.lastViewerAt,
              viewerSessions: r.body.viewerSessions, sessions,
            })
          }
        } catch { /* row lists unhydrated */ }
      }
    }))
    return { scope, owners, rows: rows.map((r) => ({ ...r, meta: metas.get(r.id) ?? null })) }
  }, [props.api])
  const allRows = list.data?.rows ?? []
  const rows = sortWith(allRows, sort.key, true, (r, k) => {
    if (k === "title") return (r.meta?.title || r.sessionID || "").toLowerCase()
    if (k === "status") return r.meta?.status ?? ""
    if (k === "owner") return (list.data?.owners.get(r.ownerId ?? "") ?? r.ownerId ?? "").toLowerCase()
    return -(r.createdAt ?? 0)
  })
  const [sel, setSel] = useList(rows.length)

  useInput((ch, key) => {
    if (detail || confirm) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "s") { sort.cycle(); return }
    if (!rows.length) return
    const row = rows[sel]
    if (key.return) setDetail(row.id)
    else if (ch === "d") setConfirm({ id: row.id })
  })

  if (detail) {
    return <ShareDetail api={props.api} id={detail} onBack={() => { setDetail(null); list.reload() }} say={props.say} />
  }
  if (confirm) {
    return (
      <Confirm
        text={`delete share ${confirm.id}?`}
        onYes={async () => {
          const r = await props.api.shareDelete(confirm.id)
          props.say(r.body?.ok ? `deleted ${confirm.id}` : `delete failed: ${r.body?.error ?? r.status}`)
          setConfirm(null); list.reload()
        }}
        onNo={() => setConfirm(null)}
      />
    )
  }
  const start = Math.max(0, sel - 14)
  return (
    <Box flexDirection="column">
      <Text bold>shares {list.data ? dim(`${list.data.scope === "all" ? "(global)" : list.data.scope === "own" ? "(yours)" : ""} · sorted by ${sort.label}`) : ""}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      <Box gap={1}>{dim("title                        status      owner           gated sub  expires")}</Box>
      {rows.length === 0 && !list.err ? dim(list.data?.scope === "denied" ? "no listing rights on this credential" : "none") : null}
      {rows.slice(start, start + 15).map((r, i) => {
        const real = start + i
        const owner = list.data?.owners.get(r.ownerId ?? "") ?? r.ownerId
        return (
          <Box key={r.id} gap={1}>
            <Text color={real === sel ? "cyan" : undefined} bold={real === sel}>{(real === sel ? "> " : "  ") + (r.meta?.title || r.sessionID || r.id).slice(0, 27).padEnd(28)}</Text>
            <StatusText status={r.meta?.status} frozen={r.meta?.frozen} />
            {dim(String(owner ?? "-").slice(0, 15).padEnd(16))}
            {r.meta ? (r.meta.gated ? <Text color="magenta">LOCK </Text> : dim("  -  ")) : dim("  ?  ")}
            {dim(String(r.meta?.subagents ?? 0).padStart(3) + "  ")}
            {dim(r.meta?.expiresAt ? relFuture(r.meta.expiresAt).padEnd(10) : "-".padEnd(10))}
          </Box>
        )
      })}
      {rows.length ? dim("enter detail · d delete · s sort") : null}
    </Box>
  )
}

function ShareDetail(props: { api: Api; id: string; onBack: () => void; say: (m: string) => void }) {
  const info = useAsync(async () => {
    const r = await props.api.shareMeta(props.id)
    if (!r.body || r.status >= 400 || !r.body?.ok) throw new Error(`private meta unavailable (${r.status}) - admin/owner only`)
    const b = r.body
    const sessions = Object.entries(b.summaries ?? {}).map(([sid, s]: [string, any]) => ({ id: sid, title: s.title, agent: s.agent, subagent: !!s.parentID, parentID: s.parentID, model: s.model, version: s.version }))
    return { b, sessions }
  }, [props.id])
  const [patching, setPatching] = useState(false)
  const [confirmFreeze, setConfirmFreeze] = useState<"freeze" | "unfreeze" | null>(null)
  useInput((ch, key) => {
    if (patching || confirmFreeze) return
    if (key.escape || ch === "b") { props.onBack(); return }
    if (ch === "p") setPatching(true)
    if (ch === "f") setConfirmFreeze(info.data?.b.frozen ? "unfreeze" : "freeze")
    if (ch === "c") { console.log(`${props.api.url}/s/${props.id}`); props.say("url printed to terminal") }
  })
  if (patching) {
    return (
      <Form
        title={`patch share ${props.id.slice(0, 10)} (blank = leave unchanged)`}
        fields={[
          { name: "secret", label: "secret (if not bearer)", optional: true, password: true },
          { name: "ttlHours", label: "ttl hours", optional: true, numeric: true },
          { name: "login", label: "gate login (with pass)", optional: true },
          { name: "pass", label: "gate pass", optional: true, password: true },
        ]}
        onCancel={() => setPatching(false)}
        onSubmit={async (v) => {
          const body: Record<string, unknown> = {}
          if (v.secret) body.secret = v.secret
          if (v.ttlHours) body.ttlHours = Number(v.ttlHours)
          if (v.login || v.pass) {
            if (!v.login || !v.pass) { props.say("gate: login and pass go together"); return }
            body.authLogin = v.login; body.authPassword = v.pass
          }
          const r = await props.api.sharePatch(props.id, body)
          props.say(r.body?.ok ? "patched" : `patch failed: ${r.body?.error ?? r.status}`)
          setPatching(false)
        }}
      />
    )
  }
  if (confirmFreeze) {
    return (
      <Confirm
        text={`${confirmFreeze} share ${props.id.slice(0, 10)}?${confirmFreeze === "freeze" ? " writes stop, viewing continues" : " writes resume"}`}
        onYes={async () => {
          const r = await props.api.shareFreeze(props.id, confirmFreeze === "freeze")
          props.say(r.body?.ok ? confirmFreeze + "d" : `failed: ${r.body?.error ?? r.status}`)
          setConfirmFreeze(null); info.reload()
        }}
        onNo={() => setConfirmFreeze(null)}
      />
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>share {props.id}</Text>
      {info.err ? <Text color="red">{info.err}</Text> : info.data ? (
        <Box flexDirection="column">
          <Text>  url: <Text color="cyan">{props.api.url}/s/{props.id}</Text></Text>
          <Text>  status: <StatusText status={info.data.b.status} frozen={info.data.b.frozen} /> · rev {info.data.b.rev} · gated {info.data.b.auth?.set ? <Text color="magenta">yes</Text> : "no"}</Text>
          <Text>  owner: {info.data.b.ownerId ?? "-"}{info.data.b.creatorTokenId ? dim(` · created by token ${info.data.b.creatorTokenId}`) : null}</Text>
          <Text>  expires: {info.data.b.expiresAt ? relFuture(info.data.b.expiresAt) : "never"} {dim(`(${info.data.b.ttlHours}h · ${fmtDate(info.data.b.createdAt)})`)}</Text>
          <Text>  liveness: plugin {rel(info.data.b.pluginSeen)} · last viewer {rel(info.data.b.lastViewerAt)} {dim(`(${info.data.b.viewerSessions} session${info.data.b.viewerSessions === 1 ? "" : "s"})`)}</Text>
          <Text>  </Text>
          {info.data.sessions.map((s) => (
            <Text key={s.id}>  {s.subagent ? dim("↳") : <Text bold color="green">●</Text>} {s.subagent ? "subagent " : "session  "}{s.id} "{s.title}" {dim(`[${s.agent ?? "-"}]${s.model ? ` ${s.model}` : ""}`)}</Text>
          ))}
        </Box>
      ) : dim("loading...")}
      {dim("p patch (ttl/gate) · f freeze/unfreeze · c print url · esc back")}
    </Box>
  )
}

// ---- users -------------------------------------------------------------------

function UsersScreen(props: { api: Api; say: (m: string) => void }) {
  const [detail, setDetail] = useState<string | null>(null)
  const sort = useSort(["created", "label"])
  const list = useAsync(async () => {
    const r = await props.api.users()
    if (!r.body?.ok) throw new Error(`${r.body?.error ?? r.status} (root only)`)
    const users: any[] = r.body.users ?? []
    const codes = await props.api.codes()
    const codeLabel = new Map<string, string>()
    if (codes.status === 200 && codes.body?.ok) for (const c of codes.body.codes ?? []) codeLabel.set(c.id, c.label)
    // their shares for the detail pane (admin list join)
    const shares = await props.api.sharesAdmin()
    const shareRows: any[] = shares.status === 200 && shares.body?.ok ? shares.body.shares ?? [] : []
    return { users, codeLabel, shareRows }
  }, [props.api])
  const all = list.data?.users ?? []
  const rows = sortWith(all, sort.key, true, (u, k) => (k === "label" ? String(u.label ?? "").toLowerCase() : -(u.createdAt ?? 0)))
  const [sel, setSel] = useList(rows.length)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<void> } | null>(null)
  useInput((ch, key) => {
    if (creating || confirm || detail) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "s") { sort.cycle(); return }
    if (ch === "n") { setCreating(true); return }
    if (!rows.length) return
    const u = rows[sel]
    if (key.return) setDetail(u.id)
    if (ch === "f") setConfirm({ what: `${u.frozen ? "unfreeze" : "freeze"} ${u.id} (${u.label})`, run: async () => { const r = u.frozen ? await props.api.userUnfreeze(u.id) : await props.api.userFreeze(u.id); props.say(r.body?.ok ? "done" : `failed: ${r.body?.error}`); list.reload() } })
    if (ch === "d") setConfirm({ what: `delete user ${u.id} (${u.label}) and all its shares/tokens`, run: async () => { const r = await props.api.userDelete(u.id, "delete"); props.say(r.body?.ok ? `deleted (${r.body.shares} shares)` : `failed: ${r.body?.error}`); list.reload() } })
  })
  if (creating) {
    return <Form title="new user" fields={[{ name: "label", label: "label" }]} onCancel={() => setCreating(false)}
      onSubmit={async (v) => { const r = await props.api.userCreate(v.label); props.say(r.body?.ok ? `created ${r.body.userId}` : `failed: ${r.body?.error}`); setCreating(false); list.reload() }} />
  }
  if (confirm) {
    return <Confirm text={confirm.what} onYes={async () => { await confirm.run(); setConfirm(null) }} onNo={() => setConfirm(null)} />
  }
  if (detail) {
    return <UserDetail api={props.api} id={detail} data={list.data} onBack={() => setDetail(null)} say={props.say} />
  }
  return (
    <Box flexDirection="column">
      <Text bold>users {dim(`(root) · sorted by ${sort.label}`)}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.map((u: any, i: number) => (
        <Box key={u.id} gap={1}>
          <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + u.id}</Text>
          <Text>{u.label}</Text>
          {dim(`s:${u.shares} t:${u.tokensActive}`)}
          {u.createdByCode ? dim(` via ${list.data?.codeLabel.get(u.createdByCode) ?? u.createdByCode}`) : null}
          {u.frozen ? <Text color="red" bold>FROZEN</Text> : null}
        </Box>
      ))}
      {rows.length ? dim("enter detail · f freeze/unfreeze · d delete · n new · s sort") : null}
    </Box>
  )
}

function UserDetail(props: { api: Api; id: string; data: { users: any[]; codeLabel: Map<string, string>; shareRows: any[] } | null; onBack: () => void; say: (m: string) => void }) {
  const detail = useAsync(async () => {
    const [tokens, shares] = await Promise.all([props.api.tokens(), props.api.sharesAdmin()])
    const toks: any[] = tokens.status === 200 && tokens.body?.ok ? (tokens.body.tokens ?? []).filter((t: any) => t.userId === props.id) : []
    const shr: any[] = shares.status === 200 && shares.body?.ok ? (shares.body.shares ?? []).filter((s: any) => s.ownerId === props.id) : []
    return { toks, shr }
  }, [props.id])
  const u = props.data?.users.find((x: any) => x.id === props.id)
  useInput((ch, key) => { if (key.escape || ch === "b") props.onBack() })
  return (
    <Box flexDirection="column">
      <Text bold>user {props.id} "{u?.label ?? ""}"{u?.frozen ? <Text color="red"> FROZEN</Text> : null}</Text>
      {u?.createdByCode ? <Text>  onboarded via code: {props.data?.codeLabel.get(u.createdByCode) ?? u.createdByCode}</Text> : dim("  onboarded without a code")}
      <Text>  </Text>
      <Text>  shares ({detail.data?.shr.length ?? 0}):</Text>
      {(detail.data?.shr ?? []).slice(0, 12).map((s: any) => (
        <Box key={s.id} gap={1}>{dim("   ")}<Text>{s.id.slice(0, 12)}</Text>{dim(s.sessionID ?? "-")}{dim(rel(s.createdAt))}</Box>
      ))}
      <Text>  tokens ({detail.data?.toks.length ?? 0}):</Text>
      {(detail.data?.toks ?? []).slice(0, 12).map((t: any) => (
        <Box key={t.id} gap={1}>
          {dim("   ")}
          <Text color={t.kind === "scoped" ? "yellow" : "green"}>{t.kind}</Text>
          <Text>{`"${t.label ?? ""}"`}</Text>
          {dim(t.revoked ? "REVOKED" : t.expiresAt ? relFuture(t.expiresAt) : "no expiry")}
          {t.createdBy ? dim(` via ${t.createdBy}`) : null}
        </Box>
      ))}
      {detail.err ? <Text color="red">{detail.err}</Text> : null}
      {dim("esc back")}
    </Box>
  )
}

// ---- tokens ------------------------------------------------------------------

function TokensScreen(props: { api: Api; conf: cfg.CliConfig; setConf: (c: cfg.CliConfig) => void; say: (m: string) => void }) {
  const sort = useSort(["created", "label", "kind", "user"])
  const [showRevoked, setShowRevoked] = useState(false)
  const list = useAsync(async () => {
    const r = await props.api.tokens()
    if (r.body?.ok) {
      const users = await props.api.users()
      const userLabel = new Map<string, string>()
      if (users.status === 200 && users.body?.ok) for (const u of users.body.users ?? []) userLabel.set(u.id, u.label)
      return { tokens: r.body.tokens ?? [], userLabel }
    }
    throw new Error(`${r.body?.error ?? r.status}`)
  }, [props.api])
  const all = list.data?.tokens ?? []
  const visible = showRevoked ? all : all.filter((t: any) => !t.revoked)
  const rows = sortWith(visible, sort.key, true, (t, k) => {
    if (k === "label") return String((t as any).label ?? "").toLowerCase()
    if (k === "kind") return (t as any).kind
    if (k === "user") return (list.data?.userLabel.get((t as any).userId) ?? (t as any).userId).toLowerCase()
    return -((t as any).createdAt ?? 0)
  })
  const [sel, setSel] = useList(rows.length)
  const [mode, setMode] = useState<null | "mint" | "edit" | "confirm-rotate" | { what: string; run: () => Promise<void> }>(null)
  useInput((ch, key) => {
    if (mode) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "s") { sort.cycle(); return }
    if (ch === "v") { setShowRevoked((v) => !v); return }
    if (ch === "m") { setMode("mint"); return }
    if (ch === "R") { setMode("confirm-rotate"); return }
    if (!rows.length) return
    const t = rows[sel] as any
    if (ch === "e") setMode("edit")
    if (ch === "x") setMode({ what: `revoke ${t.id} "${t.label}" (freezes control if it is the last full token)`, run: async () => { const r = await props.api.tokenRevoke(t.id); props.say(r.body?.ok ? `revoked (frozen: ${!!r.body.frozen})` : `failed: ${r.body?.error}`); list.reload() } })
    if (ch === "F") setMode({ what: `freeze every share created by ${t.id}`, run: async () => { const r = await props.api.tokenFreezeShares(t.id); props.say(r.body?.ok ? `froze ${r.body.shares}` : `failed: ${r.body?.error}`); list.reload() } })
  })
  if (mode === "mint") {
    return (
      <Form
        title="mint token (admin)"
        fields={[
          { name: "userId", label: "user id" },
          { name: "kind", label: "kind (full|scoped)", initial: "scoped" },
          { name: "label", label: "label", optional: true },
          { name: "maxLiveShares", label: "max live shares", optional: true, numeric: true },
          { name: "dailyCreates", label: "daily creates", optional: true, numeric: true },
          { name: "expiresInHours", label: "expires in hours (blank=never)", optional: true, numeric: true },
        ]}
        onCancel={() => setMode(null)}
        onSubmit={async (v) => {
          const limits: Record<string, number> = {}
          if (v.maxLiveShares) limits.maxLiveShares = Number(v.maxLiveShares)
          if (v.dailyCreates) limits.dailyCreates = Number(v.dailyCreates)
          const expiry: Record<string, number> = v.expiresInHours ? { expiresInHours: Number(v.expiresInHours) } : {}
          const r = await props.api.tokenMint({ userId: v.userId, kind: v.kind, label: v.label, limits: Object.keys(limits).length ? limits : undefined, ...expiry })
          if (r.body?.ok) { console.log(`token: ${r.body.token}`); props.say(`minted ${r.body.id} - token printed to terminal`) }
          else props.say(`mint failed: ${r.body?.error ?? r.status}`)
          setMode(null); list.reload()
        }}
      />
    )
  }
  if (mode === "edit") {
    const t = rows[sel] as any
    return (
      <Form
        title={`edit ${t.id}`}
        fields={[
          { name: "label", label: "label", initial: t.label ?? "" },
          { name: "maxLiveShares", label: "max live shares", initial: String(t.limits?.maxLiveShares ?? ""), optional: true, numeric: true },
          { name: "dailyCreates", label: "daily creates", initial: String(t.limits?.dailyCreates ?? ""), optional: true, numeric: true },
          { name: "expiresInHours", label: "expires in hours (blank=keep, 0=never)", initial: t.expiresAt ? String(Math.max(1, Math.round((t.expiresAt - Date.now()) / 3600000))) : "", optional: true, numeric: true },
        ]}
        onCancel={() => setMode(null)}
        onSubmit={async (v) => {
          const limits: Record<string, number> = {}
          if (v.maxLiveShares) limits.maxLiveShares = Number(v.maxLiveShares)
          if (v.dailyCreates) limits.dailyCreates = Number(v.dailyCreates)
          const expiry: Record<string, number> = {}
          if (v.expiresInHours !== "") expiry.expiresInHours = Number(v.expiresInHours || 0)
          const r = await props.api.tokenAdminUpdate(t.id, { label: v.label, limits: Object.keys(limits).length ? limits : t.limits, ...expiry })
          props.say(r.body?.ok ? `updated ${t.id}` : `failed: ${r.body?.error}`)
          setMode(null); list.reload()
        }}
      />
    )
  }
  if (mode === "confirm-rotate") {
    return (
      <Confirm
        text="rotate YOUR current credential? (old token dies immediately; the new one is saved + printed)"
        onYes={async () => {
          const r = await props.api.tokenRotate({})
          if (r.body?.ok) {
            const c = { ...props.conf }
            const cur = cfg.current(c)
            if (cur) { cfg.setToken(c, cur.name, r.body.token, r.body.tokenKind); cfg.save(c); props.setConf({ ...c }) }
            console.log(`new token: ${r.body.token}`)
            props.say("rotated - new token saved + printed")
          } else props.say(`rotate failed: ${r.body?.error ?? r.status}`)
          setMode(null)
        }}
        onNo={() => setMode(null)}
      />
    )
  }
  if (mode && typeof mode === "object") {
    return <Confirm text={mode.what} onYes={async () => { await mode.run!(); setMode(null) }} onNo={() => setMode(null)} />
  }
  const start = Math.max(0, sel - 14)
  const hidden = all.length - visible.length
  return (
    <Box flexDirection="column">
      <Text bold>tokens {dim(`${visible.length} shown${hidden ? ` (${hidden} revoked hidden, v toggles)` : ""} · sorted by ${sort.label}`)}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.length === 0 && !list.err ? dim(showRevoked ? "none" : "none active (v shows revoked)") : null}
      {rows.slice(start, start + 15).map((t: any, i: number) => {
        const real = start + i
        const user = list.data?.userLabel.get(t.userId) ?? t.userId
        return (
          <Box key={t.id} gap={1}>
            <Text color={real === sel ? "cyan" : undefined} bold={real === sel}>{(real === sel ? "> " : "  ") + t.id}</Text>
            <Text color={t.kind === "scoped" ? "yellow" : "green"}>{t.kind}</Text>
            <Text>{`"${t.label ?? ""}"`.slice(0, 20)}</Text>
            {dim(String(user).slice(0, 12).padEnd(13))}
            {t.expiresAt ? <Text color={t.expiresAt < Date.now() ? "red" : "magenta"}>{relFuture(t.expiresAt)}</Text> : dim("no-exp")}
            {t.createdBy ? dim(`via ${String(t.createdBy).slice(0, 10)}`) : null}
            {t.revoked ? <Text color="red" bold>REVOKED</Text> : null}
          </Box>
        )
      })}
      {rows.length || !list.err ? dim("e edit · x revoke · F freeze its shares · m mint · R rotate MY credential · v revoked · s sort") : null}
    </Box>
  )
}

// ---- codes -------------------------------------------------------------------

function CodesScreen(props: { api: Api; say: (m: string) => void }) {
  const list = useAsync(async () => {
    const r = await props.api.codes()
    if (!r.body?.ok) throw new Error(`${r.body?.error ?? r.status} (root only)`)
    const codes: any[] = r.body.codes ?? []
    const users = await props.api.users()
    const lineage = new Map<string, string[]>()
    if (users.status === 200 && users.body?.ok) {
      for (const u of users.body.users ?? []) {
        if (u.createdByCode) lineage.set(u.createdByCode, [...(lineage.get(u.createdByCode) ?? []), u.label || u.id])
      }
    }
    return { codes, lineage }
  }, [props.api])
  const rows = list.data?.codes ?? []
  const [sel, setSel] = useList(rows.length)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<void> } | null>(null)
  useInput((ch, key) => {
    if (creating || confirm) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "n") { setCreating(true); return }
    if (!rows.length) return
    const c = rows[sel]
    if (ch === "d") setConfirm({ what: `disable code ${c.id} (${c.label})`, run: async () => { const r = await props.api.codeDisable(c.id); props.say(r.body?.ok ? "disabled" : `failed: ${r.body?.error}`); list.reload() } })
    if (ch === "L") setConfirm({ what: `REVOKE LINEAGE of ${c.id}: kills EVERY token of EVERY user this code created`, run: async () => { const r = await props.api.codeRevokeLineage(c.id); props.say(r.body?.ok ? `revoked ${r.body.revoked} tokens, froze ${r.body.frozen}` : `failed: ${r.body?.error}`); list.reload() } })
  })
  if (creating) {
    return (
      <Form
        title="new access code"
        fields={[
          { name: "label", label: "label", initial: "invite" },
          { name: "activations", label: "activations (blank = unlimited)", optional: true, numeric: true },
          { name: "ttlHours", label: "code expires in hours (blank = never)", optional: true, numeric: true },
        ]}
        onCancel={() => setCreating(false)}
        onSubmit={async (v) => {
          const r = await props.api.codeCreate({ label: v.label, activations: v.activations ? Number(v.activations) : undefined, ttlHours: v.ttlHours ? Number(v.ttlHours) : undefined })
          if (r.body?.ok) { console.log(`code: ${r.body.code}`); props.say("created - code printed to terminal") }
          else props.say(`failed: ${r.body?.error ?? r.status}`)
          setCreating(false); list.reload()
        }}
      />
    )
  }
  if (confirm) {
    return <Confirm text={confirm.what} onYes={async () => { await confirm.run(); setConfirm(null) }} onNo={() => setConfirm(null)} />
  }
  return (
    <Box flexDirection="column">
      <Text bold>access codes {dim("(root)")}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.length === 0 && !list.err ? dim("none") : null}
      {rows.map((c: any, i: number) => {
        const on = list.data?.lineage.get(c.id) ?? []
        return (
          <Box key={c.id} gap={1}>
            <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + c.id}</Text>
            <Text>{c.label}</Text>
            {dim(`left ${c.activationsLeft < 0 ? "∞" : c.activationsLeft} · used ${c.used}`)}
            {on.length ? dim(` · onboarded ${on.slice(0, 2).join(", ")}${on.length > 2 ? ` +${on.length - 2}` : ""}`) : dim(" · no users yet")}
            {c.disabled ? <Text color="red" bold>OFF</Text> : null}
          </Box>
        )
      })}
      {rows.length ? dim("d disable · L revoke lineage (kill switch) · n new · r reload") : null}
    </Box>
  )
}

// ---- settings ----------------------------------------------------------------

function SettingsScreen(props: { api: Api; kind?: string; say: (m: string) => void }) {
  const st = useAsync(async () => {
    const r = await props.api.meSettings()
    if (r.body?.ok) return { role: "user" as const, settings: r.body.settings ?? {} }
    const h = await props.api.health()
    if (h.status === 200 && h.body?.policy) return { role: "policy" as const, policy: h.body.policy }
    throw new Error(`${r.body?.error ?? r.status} - no user settings and no policy available`)
  }, [props.api])
  const [editing, setEditing] = useState(false)
  useInput((ch) => {
    if (editing) return
    if (ch === "r") st.reload()
    if (ch === "e") setEditing(true)
  })
  if (editing && st.data?.role === "user") {
    const cur = st.data.settings as Record<string, unknown>
    return (
      <Form
        title="me settings (server-applied defaults)"
        fields={[
          { name: "defaultTtlHours", label: "default ttl hours", initial: String(cur.defaultTtlHours ?? ""), optional: true, numeric: true },
          { name: "defaultMaxLiveShares", label: "default max live shares", initial: String(cur.defaultMaxLiveShares ?? ""), optional: true, numeric: true },
          { name: "defaultDailyCreates", label: "default daily creates", initial: String(cur.defaultDailyCreates ?? ""), optional: true, numeric: true },
        ]}
        onCancel={() => setEditing(false)}
        onSubmit={async (v) => {
          const settings: Record<string, number> = { ...(st.data?.role === "user" ? st.data.settings : {}) }
          if (v.defaultTtlHours) settings.defaultTtlHours = Number(v.defaultTtlHours)
          if (v.defaultMaxLiveShares) settings.defaultMaxLiveShares = Number(v.defaultMaxLiveShares)
          if (v.defaultDailyCreates) settings.defaultDailyCreates = Number(v.defaultDailyCreates)
          const r = await props.api.meSettingsPut(settings)
          props.say(r.body?.ok ? "saved" : `failed: ${r.body?.error}`)
          setEditing(false); st.reload()
        }}
      />
    )
  }
  return (
    <Box flexDirection="column">
      {st.data?.role === "policy" ? <Text bold>server policy {dim("(read-only - this credential has no user settings)")}</Text> : <Text bold>me settings</Text>}
      {st.err ? <Text color="red">{st.err}</Text> : null}
      {st.data?.role === "user" && Object.entries(st.data.settings).map(([k, v]) => (
        <Box key={k} gap={1}><Text>  {k}</Text><Text color="cyan">{String(v)}</Text></Box>
      ))}
      {st.data?.role === "policy" && Object.entries(st.data.policy).map(([k, v]) => (
        <Box key={k} gap={1}><Text>  {k}</Text><Text color="cyan">{String(JSON.stringify(v))}</Text></Box>
      ))}
      {st.data?.role === "user" && !Object.keys(st.data.settings).length ? dim("  (empty - server defaults apply)") : null}
      {st.data?.role === "user" ? dim("e edit · r reload") : dim("r reload")}
    </Box>
  )
}

export function runTui(): void {
  render(<App />, { exitOnCtrlC: false })
}
