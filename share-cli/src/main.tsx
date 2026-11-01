/** Entry: bare `osh` opens the interactive console; any argument goes to
 *  the headless command surface (scripts, CI, agents). */
import { runCli } from "./cli"
import { runTui } from "./tui"

const argv = process.argv.slice(2)
if (argv.length === 0) {
  runTui()
} else {
  process.exit(await runCli(argv))
}
