import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`Invalid semver version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

export function isStableVersion(version) {
  return parseVersion(version).prerelease === undefined
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] > right[key]) return 1
    if (left[key] < right[key]) return -1
  }
  if (left.prerelease === right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  const leftParts = left.prerelease.split(".")
  const rightParts = right.prerelease.split(".")
  for (const index of Array.from({ length: Math.max(leftParts.length, rightParts.length) }, (_, i) => i)) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === b) continue
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1
    return a > b ? 1 : -1
  }
  return 0
}

export function maxVersion(...versions) {
  return versions.filter(Boolean).sort(compareVersions).at(-1)
}

export function bumpVersion(version, bump) {
  const parsed = parseVersion(version)
  if (bump === "major") return `${parsed.major + 1}.0.0`
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`
  if (bump === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  if (bump === "none") return `${parsed.major}.${parsed.minor}.${parsed.patch}`
  throw new Error(`Unknown bump: ${bump}`)
}

export function updatePackageVersion(version) {
  const pkg = readJson("package.json")
  pkg.version = version
  writeJson("package.json", pkg)
  if (!existsSync("package-lock.json")) return
  const lock = readJson("package-lock.json")
  lock.version = version
  if (lock.packages?.[""]) lock.packages[""].version = version
  writeJson("package-lock.json", lock)
}

export function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim()
}

export function npm(args, options = {}) {
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { encoding: "utf8", shell: process.platform === "win32", ...options }).trim()
}

export function latestStableTag() {
  const tags = git(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  return tags.sort((a, b) => compareVersions(a.slice(1), b.slice(1))).at(-1)
}

export function latestChannelTag(channel) {
  const tags = git(["tag", "--list", `${channel}/v*`])
    .split(/\r?\n/)
    .filter(Boolean)
  return tags.sort((a, b) => compareVersions(a.split("/v")[1], b.split("/v")[1])).at(-1)
}

export function conventionalBumpSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD"
  const log = git(["log", range, "--format=%s%n%b%n---END---"], { stdio: ["ignore", "pipe", "ignore"] })
  if (/BREAKING CHANGE:|^[a-zA-Z]+(?:\([^)]*\))?!:/m.test(log)) return "major"
  if (/^feat(?:\([^)]*\))?:/m.test(log)) return "minor"
  if (/^(fix|perf)(?:\([^)]*\))?:/m.test(log)) return "patch"
  return "none"
}

export function nextPrereleaseNumber(packageName, baseVersion, channel) {
  const output = npm(["view", packageName, "versions", "--json"], { stdio: ["ignore", "pipe", "ignore"] })
  const versions = JSON.parse(output || "[]")
  return versions
    .map((version) => new RegExp(`^${escapeRegExp(baseVersion)}-${channel}\\.(\\d+)$`).exec(version)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .at(-1) + 1 || 1
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
