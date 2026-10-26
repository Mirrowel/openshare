# Product

## Register

product

## Users

Recipients of shared opencode agent sessions: teammates, issue readers, the
session author himself. Context: someone pastes a link in chat or a CI log;
the reader opens it cold, mid-conversation, often on a phone, with zero
context about the tool that produced it. Primary job: read and understand
what the agent did — prompts, reasoning, tool calls, diffs, subagents —
fast, and jump between prompts in long sessions. Secondary: the session
author live-monitoring a run.

## Product Purpose

OpenShare is the share link for opencode sessions: a plugin syncs the
session to a worker, the worker serves a read-only polished transcript
page. Success = a reader absorbs a 500-message session without confusion,
misclicks, or losing their place; the page feels like a finished product,
not a debug dump.

## Brand Personality

Quiet, precise, tool-grade. Three words: calm, dense, exact. The design
never shouts; it reads like a well-set document. Mono accents for machine
facts (versions, counts, line numbers), humanist sizing for prose.
Restraint over decoration — the transcript is the interface.

## Anti-references

- "Developer tool" debug dumps: raw JSON, unstyled `<pre>` walls, browser-default link underlines and title tooltips.
- AI-slop: side-stripe accent rails, gradient text, glass cards, hero chips, emoji decoration.
- Chat-app cosplay beyond the prompt bubbles: no avatars, no timestamps on every line, no typing indicators.
- VS Code wholesale: we borrow code-surface conventions (hidden scrollbar, gutter numbers) not IDE chrome.

## Design Principles

1. The transcript is the product; chrome serves it and never competes.
2. Uniform machinery, individual voice: one card system, one nav system; skins restyle, never re-engineer.
3. Nothing shifts unless the user asked it to: expanding, syncing, and mode toggles never move what the reader is looking at.
4. Density with air: tight rhythm inside a response, clear 24px+ breaks between messages.
5. Authoritative data renders as-is; the viewer never guesses what the plugin can state.

## Accessibility & Inclusion

Keyboard-first (j/k prompts, Ctrl+K search, Esc closes); visible focus and
aria labels on every control; prefers-reduced-motion respected (kit +
ours); contrast on dark and light themes from the kit token system; the
prompt rail is reachable without a mouse.
