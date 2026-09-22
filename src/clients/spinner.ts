/** A spinner on stderr while something takes a while; silent when the output is not a terminal. */
export function spin(label: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = Boolean(process.stderr.isTTY);
  let i = 0;
  let text = label;
  const draw = () => tty && process.stderr.write(`\r\x1b[2K${frames[i++ % frames.length]} ${text}`);
  draw();
  const timer = setInterval(draw, 80);
  return {
    update(next: string) {
      text = next;
      draw();
    },
    /** Stops; with a note, leaves it on the line. */
    stop(note?: string) {
      clearInterval(timer);
      if (tty) process.stderr.write(`\r\x1b[2K${note ? `${note}\n` : ""}`);
      else if (note) process.stderr.write(`${note}\n`);
    },
  };
}
