// OpenShare site: reveal choreography, tool-row expansion, view switcher,
// live revision ticker, install-command copy. No dependencies.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

  // scroll reveals
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in")
        io.unobserve(e.target)
      }
    }
  }, { threshold: 0.12 })
  document.querySelectorAll(".rv").forEach((el) => io.observe(el))

  // tool rows: grid-rows expansion, one open at a time feels like the product
  document.querySelectorAll(".tool-head").forEach((head) => {
    head.addEventListener("click", () => {
      const tool = head.closest(".tool")
      const open = tool.classList.toggle("open")
      head.setAttribute("aria-expanded", String(open))
    })
  })

  // view switcher: crossfade the matching image, press the matching thumb
  const main = document.querySelector(".view-main")
  if (main) {
    const imgs = new Map([...main.querySelectorAll("img")].map((i) => [i.dataset.view, i]))
    const thumbs = document.querySelectorAll(".view-thumbs button")
    const pick = (view) => {
      for (const [v, img] of imgs) img.classList.toggle("shown", v === view)
      imgs.get(view)?.removeAttribute("hidden")
      imgs.forEach((img, v) => { if (v !== view) img.setAttribute("hidden", "") })
      thumbs.forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.view === view)))
    }
    thumbs.forEach((t) => t.addEventListener("click", () => pick(t.dataset.view)))
    pick("classic")
  }

  // live revision ticker: only while the band is on screen
  const revEl = document.querySelector("[data-rev]")
  const band = document.querySelector(".band")
  if (revEl && band && !reduced) {
    let rev = 41
    const tick = () => { revEl.textContent = String(++rev) }
    const bandIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) bandIo.timer ||= setInterval(tick, 2400)
        else { clearInterval(bandIo.timer); bandIo.timer = null }
      }
    }, { threshold: 0.3 })
    bandIo.observe(band)
  }

  // install command copy
  document.querySelectorAll(".cmd-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || "")
        btn.classList.add("copied")
        const hint = btn.querySelector(".copy-hint")
        const prev = hint.textContent
        hint.textContent = "copied"
        setTimeout(() => { btn.classList.remove("copied"); hint.textContent = prev }, 1600)
      } catch { /* clipboard unavailable: the command is right there to select */ }
    })
  })
})()
