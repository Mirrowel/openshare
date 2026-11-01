/** Interactive console: every mutation here has a headless twin in
 *  cli.tsx. Structure: one tab bar, one list pane, detail/actions under
 *  the selection, modals for input and confirmation. */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Text, render, useApp, useInput } from "ink"
import { Api } from "./api"
import * as cfg from "./config"

const dim = (s: string) => <Text color="gray">{s}</Text>
const fmtDate = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-")

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

// ---- app ---------------------------------------------------------------------

type Screen = "servers" | "shares" | "users" | "tokens" | "codes" | "settings"
const SCREENS: Screen[] = ["servers", "shares", "users", "tokens", "codes", "settings"]

function App() {
  const { exit } = useApp()
  const [conf, setConf] = useState(() => cfg.load())
  const cur = cfg.current(conf)
  const [screen, setScreen] = useState<Screen>("servers")
  const [toast, setToast] = useState("")
  const api = useMemo(() => new Api(cur?.entry ?? { url: "" }), [cur?.entry.url, cur?.entry.token])
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
        <StatusLine conf={conf} health={health.data?.body} me={me.data?.body} screen="servers" />
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
      {screen === "settings" && <SettingsScreen api={api} say={say} />}
      <StatusLine conf={conf} health={health.data?.body} me={me.data?.body} screen={screen} />
      <Toast toast={toast} />
    </Box>
  )
}

function StatusLine(props: { conf: cfg.CliConfig; health: any; me: any; screen: Screen }) {
  return (
    <Box marginTop={1}>
      {dim(`←→ tabs · r reload · q quit`)}
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
    else if (ch === "q") return
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

function SharesScreen(props: { api: Api; conf: cfg.CliConfig; say: (m: string) => void }) {
  const [detail, setDetail] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ id: string } | null>(null)
  const list = useAsync(async () => {
    const admin = await props.api.sharesAdmin()
    if (admin.status === 200 && admin.body?.ok) return { scope: "all" as const, rows: admin.body.shares ?? [] }
    const mine = await props.api.meShares()
    if (mine.body?.ok) return { scope: "own" as const, rows: (mine.body.shares ?? []).map((s: any) => ({ id: s.id, sessionID: s.sessionID, ownerId: null, createdAt: s.createdAt })) }
    return { scope: "denied" as const, rows: [] }
  }, [props.api])
  const rows = list.data?.rows ?? []
  const [sel, setSel] = useList(rows.length)

  useInput((ch, key) => {
    if (detail || confirm) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
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
  return (
    <Box flexDirection="column">
      <Text bold>shares {list.data ? dim(list.data.scope === "all" ? "(global)" : list.data.scope === "own" ? "(yours)" : "") : ""}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.length === 0 && !list.err ? dim(list.data?.scope === "denied" ? "no listing rights on this credential" : "none") : null}
      {rows.slice(Math.max(0, sel - 15), Math.max(0, sel - 15) + 16).map((s: any, i: number) => {
        const real = Math.max(0, sel - 15) + i
        return (
          <Box key={s.id} gap={1}>
            <Text color={real === sel ? "cyan" : undefined} bold={real === sel}>{(real === sel ? "> " : "  ") + String(s.id).slice(0, 12)}</Text>
            <Text>{String(s.sessionID ?? "-").slice(0, 26)}</Text>
            {dim(fmtDate(s.createdAt))}
            {s.ownerId ? dim(` ${s.ownerId}`) : null}
          </Box>
        )
      })}
      {rows.length ? dim("enter detail · d delete") : null}
    </Box>
  )
}

function ShareDetail(props: { api: Api; id: string; onBack: () => void; say: (m: string) => void }) {
  const info = useAsync(async () => {
    const r = await props.api.shareData(props.id)
    if (!r.body || r.status >= 400) throw new Error(`read failed (${r.status}): ${r.body?.error ?? ""}`)
    const d = r.body.data ?? []
    const types: Record<string, number> = {}
    for (const it of d) types[it.type] = (types[it.type] ?? 0) + 1
    return { status: r.body.status, rev: r.body.rev, n: d.length, types, sessionID: d.find((x: any) => x.type === "session")?.sessionID, title: d.find((x: any) => x.type === "session")?.data?.title }
  }, [props.id])
  const [patching, setPatching] = useState(false)
  useInput((ch, key) => {
    if (patching) return
    if (key.escape || ch === "b") { props.onBack(); return }
    if (ch === "p") setPatching(true)
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
  return (
    <Box flexDirection="column">
      <Text bold>share {props.id}</Text>
      {info.err ? <Text color="red">{info.err}</Text> : info.data ? (
        <Box flexDirection="column">
          <Text>  url: <Text color="cyan">{props.api.url}/s/{props.id}</Text></Text>
          <Text>  status: {info.data.status} · rev {info.data.rev} · {info.data.n} items</Text>
          <Text>  {dim(Object.entries(info.data.types).map(([k, v]) => `${k}=${v}`).join("  "))}</Text>
          {info.data.title ? <Text>  {dim(`"${info.data.title}"`)}</Text> : null}
          {info.data.sessionID ? dim(`  ${info.data.sessionID}`) : null}
        </Box>
      ) : dim("loading...")}
      {dim("p patch (ttl/gate) · c print url · esc back")}
    </Box>
  )
}

// ---- users -------------------------------------------------------------------

function UsersScreen(props: { api: Api; say: (m: string) => void }) {
  const list = useAsync(async () => {
    const r = await props.api.users()
    if (!r.body?.ok) throw new Error(`${r.body?.error ?? r.status} (root only)`)
    return r.body.users ?? []
  }, [props.api])
  const rows = list.data ?? []
  const [sel, setSel] = useList(rows.length)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<void> } | null>(null)
  useInput((ch, key) => {
    if (creating || confirm) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "n") { setCreating(true); return }
    if (!rows.length) return
    const u = rows[sel]
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
  return (
    <Box flexDirection="column">
      <Text bold>users {dim("(root)")}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.map((u: any, i: number) => (
        <Box key={u.id} gap={1}>
          <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + u.id}</Text>
          <Text>{u.label}</Text>
          {dim(`s:${u.shares} t:${u.tokensActive}`)}
          {u.frozen ? <Text color="red" bold>FROZEN</Text> : null}
        </Box>
      ))}
      {rows.length ? dim("f freeze/unfreeze · d delete · n new") : null}
    </Box>
  )
}

// ---- tokens ------------------------------------------------------------------

function TokensScreen(props: { api: Api; conf: cfg.CliConfig; setConf: (c: cfg.CliConfig) => void; say: (m: string) => void }) {
  const list = useAsync(async () => {
    const r = await props.api.tokens()
    if (r.body?.ok) return r.body.tokens ?? []
    throw new Error(`${r.body?.error ?? r.status}`)
  }, [props.api])
  const rows = (list.data ?? []).filter((t: any) => !t.revoked)
  const all = list.data ?? []
  const [sel, setSel] = useList(rows.length)
  const [mode, setMode] = useState<null | "mint" | "edit" | "confirm-rotate" | { what: string; run: () => Promise<void> }>(null)
  useInput((ch, key) => {
    if (mode) return
    if (listKeys(ch, key, sel, rows.length, setSel)) return
    if (ch === "r") { list.reload(); return }
    if (ch === "m") { setMode("mint"); return }
    if (ch === "R") { setMode("confirm-rotate"); return }
    if (!rows.length) return
    const t = rows[sel]
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
        ]}
        onCancel={() => setMode(null)}
        onSubmit={async (v) => {
          const limits: Record<string, number> = {}
          if (v.maxLiveShares) limits.maxLiveShares = Number(v.maxLiveShares)
          if (v.dailyCreates) limits.dailyCreates = Number(v.dailyCreates)
          const r = await props.api.tokenMint({ userId: v.userId, kind: v.kind, label: v.label, limits: Object.keys(limits).length ? limits : undefined })
          if (r.body?.ok) { console.log(`token: ${r.body.token}`); props.say(`minted ${r.body.id} - token printed to terminal`) }
          else props.say(`mint failed: ${r.body?.error ?? r.status}`)
          setMode(null); list.reload()
        }}
      />
    )
  }
  if (mode === "edit") {
    const t = rows[sel]
    return (
      <Form
        title={`edit ${t.id}`}
        fields={[
          { name: "label", label: "label", initial: t.label ?? "" },
          { name: "maxLiveShares", label: "max live shares", initial: String(t.limits?.maxLiveShares ?? ""), optional: true, numeric: true },
          { name: "dailyCreates", label: "daily creates", initial: String(t.limits?.dailyCreates ?? ""), optional: true, numeric: true },
        ]}
        onCancel={() => setMode(null)}
        onSubmit={async (v) => {
          const limits: Record<string, number> = {}
          if (v.maxLiveShares) limits.maxLiveShares = Number(v.maxLiveShares)
          if (v.dailyCreates) limits.dailyCreates = Number(v.dailyCreates)
          const r = await props.api.tokenAdminUpdate(t.id, { label: v.label, limits: Object.keys(limits).length ? limits : t.limits })
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
  return (
    <Box flexDirection="column">
      <Text bold>tokens {dim(`(${all.length} total, ${rows.length} active)`)}</Text>
      {list.err ? <Text color="red">{list.err}</Text> : null}
      {rows.map((t: any, i: number) => (
        <Box key={t.id} gap={1}>
          <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + t.id}</Text>
          <Text color={t.kind === "scoped" ? "yellow" : "green"}>{t.kind}</Text>
          <Text>{`"${t.label ?? ""}"`}</Text>
          {dim(`s:${t.limits?.maxLiveShares ?? "∞"} d:${t.limits?.dailyCreates ?? "∞"} used ${t.lastUsedAt ? fmtDate(t.lastUsedAt) : "never"}`)}
        </Box>
      ))}
      {rows.length || !list.err ? dim("e edit · x revoke · F freeze its shares · m mint · R rotate MY credential") : null}
    </Box>
  )
}

// ---- codes -------------------------------------------------------------------

function CodesScreen(props: { api: Api; say: (m: string) => void }) {
  const list = useAsync(async () => {
    const r = await props.api.codes()
    if (!r.body?.ok) throw new Error(`${r.body?.error ?? r.status} (root only)`)
    return r.body.codes ?? []
  }, [props.api])
  const rows = list.data ?? []
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
      {rows.map((c: any, i: number) => (
        <Box key={c.id} gap={1}>
          <Text color={i === sel ? "cyan" : undefined} bold={i === sel}>{(i === sel ? "> " : "  ") + c.id}</Text>
          <Text>{c.label}</Text>
          {dim(`left ${c.activationsLeft < 0 ? "∞" : c.activationsLeft} · used ${c.used}`)}
          {c.disabled ? <Text color="red" bold>OFF</Text> : null}
        </Box>
      ))}
      {rows.length ? dim("d disable · L revoke lineage (kill switch) · n new") : null}
    </Box>
  )
}

// ---- settings ----------------------------------------------------------------

function SettingsScreen(props: { api: Api; say: (m: string) => void }) {
  const st = useAsync(async () => {
    const r = await props.api.meSettings()
    if (!r.body?.ok) throw new Error(`${r.body?.error ?? r.status} (user identity required)`)
    return r.body.settings ?? {}
  }, [props.api])
  const [editing, setEditing] = useState(false)
  useInput((ch) => {
    if (editing) return
    if (ch === "r") st.reload()
    if (ch === "e") setEditing(true)
  })
  if (editing) {
    const cur = st.data ?? {}
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
          const settings: Record<string, number> = { ...(st.data ?? {}) }
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
      <Text bold>me settings</Text>
      {st.err ? <Text color="red">{st.err}</Text> : Object.entries(st.data ?? {}).map(([k, v]) => (
        <Box key={k} gap={1}><Text>  {k}</Text><Text color="cyan">{String(v)}</Text></Box>
      ))}
      {(st.data && !Object.keys(st.data).length) ? dim("  (empty - server defaults apply)") : null}
      {dim("e edit · r reload")}
    </Box>
  )
}

export function runTui(): void {
  render(<App />, { exitOnCtrlC: false })
}
