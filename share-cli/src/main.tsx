/** Entry: bare `osh` opens the interactive console; any argument goes to
 *  the headless command surface (scripts, CI, agents). A non-TTY stdout
 *  gets help instead of a broken half-render. */
import { runCli } from "./cli"
import { runTui } from "./tui"

const argv = process.argv.slice(2)
if (argv.length === 0) {
  if (!process.stdout.isTTY) {
    console.log("osh: interactive console needs a terminal - piping? use commands instead (osh help)")
    process.exit(1)
  }
  runTui()
} else {
  process.exit(await runCli(argv))
}
